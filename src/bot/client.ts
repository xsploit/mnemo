import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { respond, type HistoryTurn } from './respond.js';
import { handleCommand, handleComponentInteraction } from './commands.js';
import { splitMessage } from './format.js';
import { getRepliesPaused, getRespondToBots } from './botChatPolicy.js';
import {
  appendDiscordAttachmentContext,
  attachmentSummaryForHistory,
  readDiscordTextAttachmentContext,
} from './attachments.js';
import { formatShitlistReply, shitlistStore } from './shitlist.js';
import { applyMoodPresence } from '../cognition/mood.js';
import { ttsPolicy } from './ttsPolicy.js';
import { buildDiscordVoiceClip, fishTtsConfigured, sendDiscordVoiceMessage } from '../voice/fishTts.js';
import { buildTaggedFishSpeechText } from '../voice/fishSpeechTags.js';
import { appendTurnTrace } from './turnTrace.js';

const log = logger('bot');

type MsgKind = 'dm' | 'mention' | 'reply' | 'channel';

/** One pending batch of rapid-fire messages from a single author in a channel. */
interface Batch {
  messages: string[];
  last: Message;
  kind: MsgKind;
  timer: NodeJS.Timeout;
}

export function createClient(): Client {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ];
  if (config.discord.guildMembersIntent) intents.push(GatewayIntentBits.GuildMembers);

  const client = new Client({
    intents,
    partials: [Partials.Channel], // needed to receive DMs
  });

  const batches = new Map<string, Batch>();

  client.once(Events.ClientReady, (c) => log.info(`online as ${c.user.tag}`));

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction);
        return;
      }
      if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit()) {
        await handleComponentInteraction(interaction);
        return;
      }
    } catch (e: any) {
      log.error('command error', e?.message);
      const note = 'Something glitched in my head. Try again?';
      if (!interaction.isRepliable()) return;
      if (interaction.deferred || interaction.replied) await interaction.editReply(note);
      else await interaction.reply({ content: note, ephemeral: true });
    }
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (!client.user) return;
    if (msg.author.id === client.user.id) return;
    if (msg.author.bot) {
      await recordPassiveBotContext(msg);
      if (!getRespondToBots()) return;
    }

    const isDM = !msg.guild;
    const mentioned = msg.mentions.has(client.user.id);
    const isReplyToBot =
      msg.reference?.messageId != null &&
      (await msg
        .fetchReference()
        .then((r) => r.author.id === client.user!.id)
        .catch(() => false));

    // In servers, only engage when addressed: @mention or a reply to the bot.
    if (!isDM && !mentioned && !isReplyToBot) return;
    if (getRepliesPaused()) return;
    const shitlistEntry = await shitlistStore.get(msg.author.id);
    if (shitlistEntry) {
      await msg.reply({ content: formatShitlistReply(shitlistEntry), allowedMentions: { repliedUser: false } });
      return;
    }

    const kind: MsgKind = isDM ? 'dm' : isReplyToBot ? 'reply' : 'mention';
    const content = msg.content.replace(`<@${client.user.id}>`, '').trim();
    const attachmentContext = await readDiscordTextAttachmentContext(msg).catch((e: any) => {
      log.warn('Discord attachment context skipped', e?.message ?? e);
      return { text: '', includedIds: [], skipped: [] };
    });
    const turnText = appendDiscordAttachmentContext(
      content || (attachmentContext.text ? '(attached file)' : ''),
      attachmentContext.text,
    );
    if (!turnText.trim()) return;

    // Letta-style batching: coalesce a burst of messages into one turn.
    const key = `${msg.channelId}:${msg.author.id}`;
    const existing = batches.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(turnText);
      existing.last = msg;
    }
    const batch: Batch = existing ?? { messages: [turnText], last: msg, kind, timer: null as any };
    batch.timer = setTimeout(() => {
      batches.delete(key);
      void flushBatch(client, batch);
    }, Math.max(config.bot.batchMs, 0));
    batches.set(key, batch);
  });

  return client;
}

async function recordPassiveBotContext(msg: Message): Promise<void> {
  const text = passiveBotContextText(msg);
  if (!text) return;
  try {
    await appendTurnTrace({
      subjectId: msg.author.id,
      channelId: msg.channelId,
      messageId: msg.id,
      authorName: `${msg.author.displayName ?? msg.author.username} (bot)`,
      kind: 'passive-bot-context',
      prompt: text,
      answer: '',
      model: 'discord-passive-context',
      systemChars: 0,
      promptChars: text.length,
      history: [],
      retrieved: [],
      affect: null,
      toolTrace: [],
    });
  } catch (e: any) {
    log.warn('passive bot context skipped', e?.message ?? e);
  }
}

function passiveBotContextText(msg: Message): string {
  return [msg.cleanContent || msg.content, attachmentSummaryForHistory(msg), embedSummaryForHistory(msg)]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function embedSummaryForHistory(msg: Message): string {
  if (msg.embeds.length === 0) return '';
  const summaries = msg.embeds.slice(0, 5).map((embed, index) => {
    const data = embed.toJSON() as {
      title?: string;
      description?: string;
      url?: string;
      author?: { name?: string };
      footer?: { text?: string };
      fields?: { name?: string; value?: string }[];
    };
    const fields = (data.fields ?? []).slice(0, 5).flatMap((field) => [field.name, field.value]);
    const parts = [data.author?.name, data.title, data.description, ...fields, data.footer?.text, data.url]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.replace(/\s+/g, ' ').trim());
    return `embed ${index + 1}: ${parts.join(' | ')}`;
  });
  return `[embeds: ${summaries.join('; ')}]`;
}

async function fetchHistory(channel: TextBasedChannel, n: number, excludeId: string): Promise<HistoryTurn[]> {
  if (n <= 0 || !('messages' in channel)) return [];
  try {
    const fetched = await channel.messages.fetch({ limit: Math.min(n + 1, 25) });
    return [...fetched.values()]
      .filter((m) => m.id !== excludeId && (m.content.trim().length > 0 || m.attachments.size > 0))
      .reverse()
      .slice(-n)
      .map((m) => ({
        author: m.author.id === channel.client.user?.id ? `${m.author.displayName} (you)` : m.author.bot ? `${m.author.displayName} (bot)` : m.author.displayName,
        content: [m.content, attachmentSummaryForHistory(m)].filter(Boolean).join(' '),
      }));
  } catch {
    return [];
  }
}

async function flushBatch(client: Client, batch: Batch): Promise<void> {
  const msg = batch.last;
  if (getRepliesPaused()) return;
  const shitlistEntry = await shitlistStore.get(msg.author.id);
  if (shitlistEntry) {
    await msg.reply({ content: formatShitlistReply(shitlistEntry), allowedMentions: { repliedUser: false } });
    return;
  }
  const message = batch.messages.join('\n');
  try {
    if ('sendTyping' in msg.channel) await msg.channel.sendTyping();
    const history = await fetchHistory(msg.channel, config.bot.historyN, msg.id);
    const ttsOn = fishTtsConfigured() && (await ttsPolicy.isEnabled(msg.channelId));
    const response = await respond({
      subjectId: msg.author.id,
      channelId: msg.channelId,
      messageId: msg.id,
      userName: msg.author.displayName ?? msg.author.username,
      message,
      history,
      kind: batch.kind,
      toolScope: {
        channelId: msg.channelId,
        guildId: msg.guildId,
        messageId: msg.id,
        authorId: msg.author.id,
        authorName: msg.author.displayName ?? msg.author.username,
        authorPermissions: msg.member?.permissions ?? null,
        client,
        guild: msg.guild,
        channel: msg.channel,
      },
    });
    const reply = response.message;
    if (config.bot.moodPresence) applyMoodPresence(client);
    const chunks = splitMessage(reply);
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i]!;
      if (i === 0) {
        // Reply to the user's message, but if that message was deleted the
        // reference is gone — fall back to a plain channel send instead of erroring.
        await msg.reply(part).catch(async () => {
          if ('send' in msg.channel) await msg.channel.send(part);
        });
      } else if ('send' in msg.channel) {
        await msg.channel.send(part);
      }
    }

    // Voice clip: text first, then her voice, when TTS is on for this channel.
    log.debug(`tts gate: configured=${fishTtsConfigured()} channelOn=${ttsOn}`);
    if (ttsOn && 'send' in msg.channel) {
      const voiceText = await buildTaggedFishSpeechText({
        displayText: reply,
        affect: response.affect,
        userName: msg.author.displayName ?? msg.author.username,
      });
      const clip = await buildDiscordVoiceClip(voiceText, 'hikari');
      if (clip) {
        const sentId = await sendDiscordVoiceMessage(msg.channelId, clip).catch((e: any) => {
          log.warn('voice message send failed', e?.message ?? e);
          return null;
        });
        log.info(`voice message: ${clip.ogg.length} bytes duration=${clip.durationSecs}s message=${sentId ?? 'failed'} → #${msg.channelId}`);
      } else {
        log.warn('voice clip synth returned null (check FISH_* config / API)');
      }
    }
  } catch (e: any) {
    log.error('message handling failed', e?.message);
    await msg.reply('…my head went quiet for a sec. Say that again?').catch(() => {});
  }
}

export async function startBot(): Promise<Client> {
  const client = createClient();
  await client.login(config.discord.token);
  return client;
}
