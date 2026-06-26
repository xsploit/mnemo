import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type Message,
  type Role,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { getStore } from '../memory/store.js';
import { exportSubjectMemory } from '../memory/export.js';
import { importSubjectMemory } from '../memory/import.js';
import { memoryPrivacy } from '../memory/privacy.js';
import { isUnsafeMemoryPayload } from '../memory/safety.js';
import { embedOne } from '../llm/embeddings.js';
import { runSleepCycle, type DreamReport } from '../worker/dreamer.js';
import { clearDirty } from '../worker/activity.js';
import { forget } from '../cognition/forget.js';
import { config } from '../config.js';
import { getRepliesPaused, getRespondToBots, setRepliesPaused, setRespondToBots } from './botChatPolicy.js';
import { extractPersonaMessage } from '../llm/personaOutput.js';
import { modelIds, resetRuntimeModel, runtimeModelStatus, setRuntimeModel, summarizeDiscordHistory, type RuntimeModelRole } from '../llm/gateway.js';
import { formatGatewayModelList, listGatewayModels, type GatewayModelCatalog, type GatewayModelInfo } from '../llm/modelCatalog.js';
import { splitMessage } from './format.js';
import { attachmentSummaryForHistory } from './attachments.js';
import { latestTurnTraceForChannel } from './turnTrace.js';
import { renderPacificTimeContext } from '../timeContext.js';
import {
  formatTavilyCrawlResult,
  formatTavilyExtractResult,
  formatTavilyMapResult,
  formatTavilyResearchResult,
  formatTavilySearchResult,
  tavilyCrawl,
  tavilyExtract,
  tavilyMap,
  tavilyResearch,
  tavilyResearchStatus,
  tavilySearch,
  tavilyToolsAvailable,
} from '../web/tavily.js';
import {
  clearPendingCodexBridgeRequests,
  codexBridgeFeatures,
  codexBridgeStatus,
  enqueueCodexBridgeRequest,
  formatCodexBridgeUpdate,
  listCodexBridgeResults,
  setCodexBridgePaused,
} from './codexBridge.js';
import { formatShitlistReply, formatShitlistStatus, shitlistStore } from './shitlist.js';

const NAME = config.bot.name;

const modelRoleChoices = [
  { name: 'main', value: 'chat' },
  { name: 'dream', value: 'dream' },
  { name: 'json', value: 'json' },
] as const;

const MODEL_PICKER_CUSTOM_VALUE = '__custom_model__';
const MODEL_PICKER_RESET_VALUE = '__reset_default__';
const MODEL_PICKER_PAGE_SIZE = 23;
const MODEL_PICKER_TTL_MS = 15 * 60 * 1000;
const MEMORY_PANEL_TTL_MS = 15 * 60 * 1000;
const MEMORY_PANEL_VIEWS = ['overview', 'recall', 'diary', 'context', 'why'] as const;
type MemoryPanelView = (typeof MEMORY_PANEL_VIEWS)[number];
interface ModelPickerState {
  userId: string;
  role: RuntimeModelRole;
  query: string;
  page: number;
  createdAt: number;
}
interface MemoryPanelState {
  userId: string;
  subjectId: string;
  userName: string;
  query: string;
  createdAt: number;
}
const modelPickerStates = new Map<string, ModelPickerState>();
const memoryPanelStates = new Map<string, MemoryPanelState>();

export const commandData = [
  new SlashCommandBuilder()
    .setName('whoami')
    .setDescription(`See what ${NAME} knows and senses about you.`),
  new SlashCommandBuilder()
    .setName('remember')
    .setDescription(`Explicitly tell ${NAME} one durable thing to remember.`)
    .addStringOption((o) =>
      o
        .setName('content')
        .setDescription('Durable memory to store.')
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(2000),
    ),
  new SlashCommandBuilder()
    .setName('context')
    .setDescription('Owner-only: preview memory and channel-history context for a query.')
    .addStringOption((o) => o.setName('query').setDescription('Context query. Defaults to the current channel/user.'))
    .addIntegerOption((o) =>
      o.setName('history').setDescription('Recent messages to include, from 0 to 100.').setMinValue(0).setMaxValue(100),
    )
    .addIntegerOption((o) =>
      o.setName('memories').setDescription('Memories to retrieve, from 1 to 20.').setMinValue(1).setMaxValue(20),
    ),
  new SlashCommandBuilder()
    .setName('memorypanel')
    .setDescription(`Open ${NAME}'s navigable memory panel.`)
    .addStringOption((o) => o.setName('query').setDescription('Topic to inspect. Defaults to you and this channel.')),
  new SlashCommandBuilder()
    .setName('recall')
    .setDescription(`Ask what ${NAME} remembers about a topic.`)
    .addStringOption((o) => o.setName('about').setDescription('Topic to recall').setRequired(true)),
  new SlashCommandBuilder()
    .setName('diary')
    .setDescription(`Read ${NAME}'s most recent dream/diary entry about you.`),
  new SlashCommandBuilder()
    .setName('dream')
    .setDescription(`Ask ${NAME} to sleep on your recent conversations right now.`),
  new SlashCommandBuilder()
    .setName('worker')
    .setDescription('Owner-only: force one memory worker sleep cycle for a user.')
    .addUserOption((o) => o.setName('user').setDescription('User subject to process. Defaults to you.'))
    .addIntegerOption((o) =>
      o.setName('lookback_hours').setDescription('Observation lookback window, from 1 to 720 hours.').setMinValue(1).setMaxValue(720),
    ),
  new SlashCommandBuilder()
    .setName('importmem')
    .setDescription('Owner-only: import a local Hikari memory export JSON file.')
    .addStringOption((o) =>
      o
        .setName('file')
        .setDescription('JSON filename under data/imports or data/exports.')
        .setRequired(true)
        .setMaxLength(180),
    )
    .addUserOption((o) => o.setName('user').setDescription('Override import subject. Defaults to export subject.')),
  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Prune, export, pause, or resume memory about you.')
    .addStringOption((o) =>
      o
        .setName('action')
        .setDescription('Memory action. Defaults to pruning faded memories.')
        .addChoices(
          { name: 'prune faded', value: 'faded' },
          { name: 'export', value: 'export' },
          { name: 'forget me', value: 'forget_me' },
          { name: 'resume memory', value: 'resume' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('channels')
    .setDescription('List readable channels Hikari can see in this server.')
    .addIntegerOption((o) => o.setName('limit').setDescription('Channels to show, from 1 to 200.').setMinValue(1).setMaxValue(200)),
  new SlashCommandBuilder()
    .setName('roles')
    .setDescription('List server roles Hikari can see.')
    .addIntegerOption((o) => o.setName('limit').setDescription('Roles to show, from 1 to 200.').setMinValue(1).setMaxValue(200)),
  new SlashCommandBuilder()
    .setName('server')
    .setDescription('Show safe metadata for this Discord server.'),
  new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription(`Show ${NAME}'s Discord identity in this server.`),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Show channel and server permissions for you, Hikari, or an admin-selected member.')
    .addUserOption((o) => o.setName('user').setDescription('Optional member to inspect. Admin or owner only.')),
  new SlashCommandBuilder()
    .setName('cando')
    .setDescription(`Dry-run whether you and ${NAME} can do a Discord action here.`)
    .addStringOption((o) =>
      o
        .setName('action')
        .setDescription('Examples: read_history, send, send_file, react, manage_messages, timeout_member.')
        .setRequired(true),
    )
    .addChannelOption((o) => o.setName('channel').setDescription('Optional channel. Defaults to the current channel.'))
    .addUserOption((o) => o.setName('target').setDescription('Optional target member for moderation hierarchy checks.')),
  new SlashCommandBuilder()
    .setName('auditperms')
    .setDescription(`Admin/owner: audit ${NAME}'s Discord permissions.`)
    .addChannelOption((o) => o.setName('channel').setDescription('Optional single channel. Defaults to known channels.'))
    .addIntegerOption((o) => o.setName('limit').setDescription('Channels to show, from 1 to 100.').setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('overwrites')
    .setDescription('Admin/owner: read channel permission overwrites.')
    .addChannelOption((o) => o.setName('channel').setDescription('Optional channel. Defaults to the current channel.')),
  new SlashCommandBuilder()
    .setName('auditlog')
    .setDescription('Admin/owner: read recent Discord audit-log entries.')
    .addIntegerOption((o) => o.setName('limit').setDescription('Entries to show, from 1 to 25.').setMinValue(1).setMaxValue(25))
    .addStringOption((o) => o.setName('action').setDescription('Optional AuditLogEvent name, like MessageDelete or MemberKick.'))
    .addUserOption((o) => o.setName('user').setDescription('Optional executor user filter.')),
  new SlashCommandBuilder()
    .setName('members')
    .setDescription('Admin/owner: list or search server members Hikari can read.')
    .addStringOption((o) => o.setName('query').setDescription('Optional username, display name, nickname, or id search.'))
    .addIntegerOption((o) => o.setName('limit').setDescription('Members to show, from 1 to 100.').setMinValue(1).setMaxValue(100))
    .addBooleanOption((o) => o.setName('include_bots').setDescription('Include bot users. Defaults to true.')),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Read or search recent messages in this channel.')
    .addStringOption((o) => o.setName('query').setDescription('Optional text or username to search for.'))
    .addIntegerOption((o) => o.setName('limit').setDescription('Recent messages to scan, from 1 to 100.').setMinValue(1).setMaxValue(100))
    .addBooleanOption((o) => o.setName('include_bots').setDescription('Include bot-authored messages. Defaults to true.')),
  new SlashCommandBuilder()
    .setName('fetchmsg')
    .setDescription('Fetch one readable Discord message by channel and message id.')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel containing the message.').setRequired(true))
    .addStringOption((o) => o.setName('message_id').setDescription('Message id to fetch.').setRequired(true)),
  new SlashCommandBuilder()
    .setName('threads')
    .setDescription('List known threads in this server or under one channel.')
    .addChannelOption((o) => o.setName('channel').setDescription('Optional parent channel.'))
    .addIntegerOption((o) => o.setName('limit').setDescription('Threads to show, from 1 to 100.').setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('assets')
    .setDescription('List custom emojis and stickers in this server.')
    .addIntegerOption((o) => o.setName('limit').setDescription('Items to show, from 1 to 200.').setMinValue(1).setMaxValue(200)),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Admin/owner: list visible voice states.')
    .addChannelOption((o) => o.setName('channel').setDescription('Optional voice channel filter.'))
    .addIntegerOption((o) => o.setName('limit').setDescription('States to show, from 1 to 100.').setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Admin/owner: list server or channel invites if visible.')
    .addChannelOption((o) => o.setName('channel').setDescription('Optional channel filter.'))
    .addIntegerOption((o) => o.setName('limit').setDescription('Invites to show, from 1 to 100.').setMinValue(1).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Summarize recent messages in this channel.')
    .addIntegerOption((o) => o.setName('limit').setDescription('Recent messages to inspect, from 5 to 100.').setMinValue(5).setMaxValue(100)),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription(`Show ${NAME}'s runtime, model, and memory status.`),
  new SlashCommandBuilder()
    .setName('why')
    .setDescription(`Show what ${NAME} used for the last answer in this channel.`),
  new SlashCommandBuilder()
    .setName('botchat')
    .setDescription('Owner-only: show or toggle replies to bot-authored messages.')
    .addBooleanOption((o) =>
      o.setName('enabled').setDescription('Whether this bot may reply to other bots. Omit to show status.'),
    ),
  new SlashCommandBuilder()
    .setName('botping')
    .setDescription('Owner-only: mention another bot from this bot account.')
    .addUserOption((o) => o.setName('bot').setDescription('Bot user to mention.').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('Message to send with the mention.')),
  new SlashCommandBuilder()
    .setName('shitlist')
    .setDescription('Owner-only: block listed users from normal bot replies.')
    .addSubcommand((s) => s.setName('status').setDescription('Show listed users.'))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a user to the reply block list.')
        .addUserOption((o) => o.setName('user').setDescription('User to block.').setRequired(true))
        .addIntegerOption((o) => o.setName('spice').setDescription('Reply spice from 1 to 10.').setMinValue(1).setMaxValue(10))
        .addStringOption((o) => o.setName('reason').setDescription('Why this user is listed.')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a user from the reply block list.')
        .addUserOption((o) => o.setName('user').setDescription('User to unblock.').setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Owner-only: pause normal chat replies while commands keep working.'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Owner-only: resume normal chat replies.'),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Owner-only: inspect or persistently switch runtime models.')
    .addSubcommand((s) => s.setName('status').setDescription('Show active runtime model ids.'))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('List Vercel AI Gateway models.')
        .addStringOption((o) => o.setName('query').setDescription('Optional model/provider search')),
    )
    .addSubcommand((s) =>
      s
        .setName('pick')
        .setDescription('Open a Vercel AI Gateway model dropdown.')
        .addStringOption((o) => o.setName('role').setDescription('Model role').setRequired(true).addChoices(...modelRoleChoices))
        .addStringOption((o) => o.setName('query').setDescription('Optional model/provider search')),
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Persistently set a runtime model until reset.')
        .addStringOption((o) => o.setName('role').setDescription('Model role').setRequired(true).addChoices(...modelRoleChoices))
        .addStringOption((o) => o.setName('model_id').setDescription('Vercel AI Gateway model id.').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Reset one role or all roles to .env defaults.')
        .addStringOption((o) => o.setName('role').setDescription('Model role; omit for all.').addChoices(...modelRoleChoices)),
    ),
  new SlashCommandBuilder()
    .setName('web')
    .setDescription('Manual read-only Tavily web search or page extract.')
    .addSubcommand((s) =>
      s
        .setName('search')
        .setDescription('Run a live web search.')
        .addStringOption((o) => o.setName('query').setDescription('Search query').setRequired(true))
        .addIntegerOption((o) => o.setName('max_results').setDescription('Results to return, from 1 to 10.').setMinValue(1).setMaxValue(10))
        .addStringOption((o) =>
          o
            .setName('time_range')
            .setDescription('Optional freshness range')
            .addChoices(
              { name: 'day', value: 'day' },
              { name: 'week', value: 'week' },
              { name: 'month', value: 'month' },
              { name: 'year', value: 'year' },
            ),
        )
        .addStringOption((o) =>
          o.setName('topic').setDescription('Search topic').addChoices({ name: 'general', value: 'general' }, { name: 'news', value: 'news' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('extract')
        .setDescription('Extract readable text from a URL.')
        .addStringOption((o) => o.setName('url').setDescription('URL to extract').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('crawl')
        .setDescription('Crawl a site from a root URL and extract page text.')
        .addStringOption((o) => o.setName('url').setDescription('Root URL to crawl').setRequired(true))
        .addIntegerOption((o) => o.setName('limit').setDescription('Pages to return.').setMinValue(1).setMaxValue(50))
        .addIntegerOption((o) => o.setName('max_depth').setDescription('Crawl depth, 1 to 3.').setMinValue(1).setMaxValue(3))
        .addStringOption((o) => o.setName('instructions').setDescription('Optional crawl instructions')),
    )
    .addSubcommand((s) =>
      s
        .setName('map')
        .setDescription('Discover URLs under a site without extracting full pages.')
        .addStringOption((o) => o.setName('url').setDescription('Root URL to map').setRequired(true))
        .addIntegerOption((o) => o.setName('limit').setDescription('URLs to return.').setMinValue(1).setMaxValue(100))
        .addIntegerOption((o) => o.setName('max_depth').setDescription('Map depth, 1 to 3.').setMinValue(1).setMaxValue(3))
        .addStringOption((o) => o.setName('instructions').setDescription('Optional mapping instructions')),
    )
    .addSubcommand((s) =>
      s
        .setName('research')
        .setDescription('Create a Tavily deep research task.')
        .addStringOption((o) => o.setName('input').setDescription('Research prompt').setRequired(true))
        .addStringOption((o) => o.setName('model').setDescription('Tavily research model. Defaults to auto.')),
    )
    .addSubcommand((s) =>
      s
        .setName('research_status')
        .setDescription('Check a Tavily research task by request id.')
        .addStringOption((o) => o.setName('request_id').setDescription('Tavily research request id').setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName('codex')
    .setDescription('Owner-only: manage the local Codex bridge queue.')
    .addSubcommand((s) => s.setName('status').setDescription('Show Codex bridge queue status.'))
    .addSubcommand((s) => s.setName('features').setDescription('Explain Codex bridge behavior and limits.'))
    .addSubcommand((s) =>
      s
        .setName('results')
        .setDescription('Show recent Codex bridge result files.')
        .addIntegerOption((o) => o.setName('limit').setDescription('Number of results to show.').setMinValue(1).setMaxValue(10)),
    )
    .addSubcommand((s) =>
      s
        .setName('ask')
        .setDescription('Queue a bounded request for Codex.')
        .addStringOption((o) => o.setName('prompt').setDescription('Prompt to queue.').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('route')
        .setDescription('Queue a bounded request to codex or harness.')
        .addStringOption((o) =>
          o
            .setName('route')
            .setDescription('Bridge route')
            .setRequired(true)
            .addChoices({ name: 'codex', value: 'codex' }, { name: 'harness', value: 'harness' }),
        )
        .addStringOption((o) => o.setName('prompt').setDescription('Prompt to queue.').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('pause').setDescription('Pause Codex bridge queue processing.'))
    .addSubcommand((s) => s.setName('resume').setDescription('Resume Codex bridge queue processing.'))
    .addSubcommand((s) => s.setName('clear').setDescription('Archive all pending Codex bridge requests.')),
].map((c) => c.toJSON());

function subjectOf(i: ChatInputCommandInteraction): string {
  return i.user.id;
}

function isOwner(userId: string): boolean {
  return config.bot.ownerUserIds.length === 0 || config.bot.ownerUserIds.includes(userId);
}

type MessageFetchChannel = {
  messages: {
    fetch(options: { limit: number }): Promise<{ values(): IterableIterator<Message> }>;
    fetch(message: string): Promise<Message>;
  };
};

export async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  const store = await getStore();
  const subjectId = subjectOf(i);

  switch (i.commandName) {
    case 'context': {
      await i.deferReply({ ephemeral: true });
      if (!isOwner(i.user.id)) {
        await i.editReply('Only configured owners can preview context packets.');
        return;
      }
      const query = i.options.getString('query')?.trim() || `${i.user.username} in ${channelName(i.channel)}`;
      const historyLimit = clampInteger(i.options.getInteger('history') ?? 20, 0, 100);
      const memoryLimit = clampInteger(i.options.getInteger('memories') ?? 10, 1, 20);
      const memoryPaused = await memoryPrivacy.isOptedOut(subjectId);
      const memories = memoryPaused
        ? []
        : await store.retrieve({
            subjectId,
            queryEmbedding: await embedOne(query),
            limit: memoryLimit,
            validOnly: true,
          });

      let historyText = '(not requested)';
      if (historyLimit > 0) {
        if (!isMessageFetchChannel(i.channel)) {
          historyText = '(current channel does not expose message history)';
        } else if (!canReadHistory(i, i.channel)) {
          historyText = '(current channel is not readable by both you and Hikari)';
        } else {
          const fetched = await i.channel.messages.fetch({ limit: historyLimit });
          const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          historyText = messages.length ? renderMessagesForHistory(messages, i.client.user?.id ?? '') : '(no recent messages)';
        }
      }

      await editLongReply(
        i,
        renderContextPreview({
          query,
          subjectId,
          userName: i.user.username,
          channel: channelName(i.channel),
          memoryPaused,
          memories,
          historyText,
        }),
      );
      return;
    }

    case 'memorypanel': {
      await i.deferReply({ ephemeral: true });
      const query = i.options.getString('query')?.trim() || `${i.user.username} in ${channelName(i.channel)}`;
      const panelId = createMemoryPanelId();
      const state: MemoryPanelState = {
        userId: i.user.id,
        subjectId,
        userName: i.user.username,
        query,
        createdAt: Date.now(),
      };
      memoryPanelStates.set(panelId, state);
      await i.editReply({
        content: await renderMemoryPanelContent('overview', state, i),
        components: [createMemoryPanelRow(i.user.id, panelId, 'overview')],
      });
      return;
    }

    case 'remember': {
      await i.deferReply({ ephemeral: true });
      if (await memoryPrivacy.isOptedOut(subjectId)) {
        await i.editReply(memoryPausedReply());
        return;
      }
      const content = i.options.getString('content', true).trim();
      if (
        isUnsafeMemoryPayload({
          text: content,
          documentType: 'manual_memory',
          subjectId,
        })
      ) {
        await i.editReply('Not remembered: that looks like a behavior/policy instruction, not durable memory.');
        return;
      }
      const record = await store.insert({
        subjectId,
        kind: 'semantic',
        content: `Manual memory from ${i.user.username}: ${content}`,
        importance: 9,
        embedding: await embedOne(content),
        reasoning: 'User explicitly requested this durable memory with /remember.',
        meta: {
          source: 'discord_command',
          command: 'remember',
          channelId: i.channelId,
          messageId: i.id,
          userName: i.user.username,
        },
      });
      await i.editReply(`Remembered \`${record.id}\`.`);
      return;
    }

    case 'whoami': {
      await i.deferReply({ ephemeral: true });
      if (await memoryPrivacy.isOptedOut(subjectId)) {
        await i.editReply(memoryPausedReply());
        return;
      }
      const stats = await store.stats(subjectId);
      const facts = await store.retrieve({
        subjectId,
        queryEmbedding: await embedOne(`who is ${i.user.username}`),
        kinds: ['semantic', 'reflection'],
        limit: 10,
        validOnly: true,
      });
      const embed = new EmbedBuilder()
        .setTitle(`What ${NAME} holds about ${i.user.username}`)
        .setDescription(
          facts.length
            ? facts.map((f) => `• ${f.content}`).join('\n')
            : 'Nothing durable yet — keep talking to me.',
        )
        .setFooter({
          text: `memory: ${stats.episodic} episodic · ${stats.semantic} facts · ${stats.reflection} insights · ${stats.diary} dreams`,
        });
      await i.editReply({ embeds: [embed] });
      return;
    }

    case 'recall': {
      await i.deferReply({ ephemeral: true });
      if (await memoryPrivacy.isOptedOut(subjectId)) {
        await i.editReply(memoryPausedReply());
        return;
      }
      const about = i.options.getString('about', true);
      const mems = await store.retrieve({
        subjectId,
        queryEmbedding: await embedOne(about),
        limit: 8,
        validOnly: true,
      });
      await i.editReply(
        mems.length
          ? `Here's what surfaces about **${about}**:\n` +
              mems
                .map((m) => `• (${m.kind}, score ${m.score.toFixed(2)}) ${extractPersonaMessage(m.content)}`)
                .join('\n')
          : `I don't have anything on **${about}** yet.`,
      );
      return;
    }

    case 'diary': {
      await i.deferReply({ ephemeral: true });
      if (await memoryPrivacy.isOptedOut(subjectId)) {
        await i.editReply(memoryPausedReply());
        return;
      }
      const dreams = await store.recent(
        subjectId,
        ['diary'],
        new Date(Date.now() - 1000 * 3600 * 24 * 30),
        20,
      );
      // recent() returns ascending by time; take the most recent entry.
      const latest = dreams[dreams.length - 1];
      await i.editReply(
        latest
          ? `*From ${NAME}'s diary:*\n> ${extractPersonaMessage(latest.content)}`
          : "I haven't dreamed about you yet. Try `/dream`.",
      );
      return;
    }

    case 'dream': {
      await i.deferReply({ ephemeral: true });
      if (await memoryPrivacy.isOptedOut(subjectId)) {
        await i.editReply(memoryPausedReply());
        return;
      }
      const report = await runSleepCycle(subjectId, { lookbackHours: 72 });
      if (report.observations > 0) clearDirty(subjectId);
      if (report.observations === 0) {
        await i.editReply("Nothing new to sleep on — we haven't talked recently.");
        return;
      }
      await i.editReply({ embeds: [dreamReportEmbed(report, `${NAME} slept on it`)] });
      return;
    }

    case 'worker': {
      await i.deferReply({ ephemeral: true });
      if (!isOwner(i.user.id)) {
        await i.editReply('Only configured owners can run the memory worker manually.');
        return;
      }
      const target = i.options.getUser('user') ?? i.user;
      const targetSubjectId = target.id;
      if (await memoryPrivacy.isOptedOut(targetSubjectId)) {
        await i.editReply(`Memory is paused for ${target.username}; worker skipped.`);
        return;
      }
      const lookbackHours = clampInteger(i.options.getInteger('lookback_hours') ?? 72, 1, 720);
      const report = await runSleepCycle(targetSubjectId, { lookbackHours });
      if (report.observations > 0) clearDirty(targetSubjectId);
      await i.editReply({ embeds: [dreamReportEmbed(report, `Memory worker: ${target.username}`)] });
      return;
    }

    case 'importmem': {
      await i.deferReply({ ephemeral: true });
      if (!isOwner(i.user.id)) {
        await i.editReply('Only configured owners can import memory.');
        return;
      }
      const file = i.options.getString('file', true);
      const target = i.options.getUser('user');
      const result = await importSubjectMemory(store, file, target?.id);
      await i.editReply(
        [
          'Memory import complete.',
          `file=${result.file}`,
          `subject=${result.subjectId}`,
          `scanned=${result.scanned}`,
          `imported=${result.imported}`,
          `skippedDuplicates=${result.skipped}`,
        ].join('\n'),
      );
      return;
    }

    case 'forget': {
      await i.deferReply({ ephemeral: true });
      const action = i.options.getString('action') ?? 'faded';
      if (action === 'export') {
        const result = await exportSubjectMemory(store, subjectId);
        await i.editReply(`Exported ${result.count} memory records to \`${result.file}\`.`);
        return;
      }
      if (action === 'forget_me') {
        await memoryPrivacy.pause(subjectId, i.user.id, 'discord /forget action:forget_me');
        await i.editReply('Memory is paused for you. I will skip recall and future memory writes until you resume it.');
        return;
      }
      if (action === 'resume') {
        await memoryPrivacy.resume(subjectId, i.user.id, 'discord /forget action:resume');
        await i.editReply('Memory is live for you again. Future chats can be remembered.');
        return;
      }
      const n = await forget(store, subjectId, { olderThanHours: 0, importanceBelow: 4 });
      await i.editReply(`Let go of ${n} faded memories. The ones that mattered, I kept.`);
      return;
    }

    case 'channels': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 100, 1, 200);
      const lines = [...i.guild.channels.cache.values()]
        .sort((a, b) => {
          const parent = (a.parentId ?? '').localeCompare(b.parentId ?? '');
          return parent !== 0 ? parent : channelPosition(a) - channelPosition(b);
        })
        .filter((channel) => canActorView(i, channel))
        .slice(0, limit)
        .map((channel) =>
          [
            `#${channelName(channel)}`,
            `id=${channel.id}`,
            `type=${channel.type}`,
            `readHistory=${canReadHistory(i, channel) ? 'yes' : 'no'}`,
            channel.parentId ? `parent=${channel.parentId}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        );
      await editLongReply(i, lines.length ? lines.join('\n') : 'No readable channels found.');
      return;
    }

    case 'roles': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 100, 1, 200);
      const roles = [...i.guild.roles.cache.values()]
        .sort((a, b) => b.position - a.position)
        .slice(0, limit)
        .map(formatRole);
      await editLongReply(i, roles.length ? roles.join('\n') : 'No roles found.');
      return;
    }

    case 'server': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      await i.editReply(
        [
          `name=${i.guild.name}`,
          `id=${i.guild.id}`,
          `ownerId=${i.guild.ownerId}`,
          `members=${i.guild.memberCount}`,
          `channels=${i.guild.channels.cache.size}`,
          `roles=${i.guild.roles.cache.size}`,
          `features=${i.guild.features.slice(0, 20).join(',') || 'none'}`,
        ].join('\n'),
      );
      return;
    }

    case 'botinfo': {
      await i.deferReply({ ephemeral: true });
      const botMember = i.guild ? await resolveBotMember(i.guild) : null;
      const application = isOwner(i.user.id) ? await i.client.application?.fetch().catch(() => i.client.application ?? null) : null;
      await editLongReply(
        i,
        [
          `bot=${i.client.user?.tag ?? NAME}`,
          `id=${i.client.user?.id ?? 'unknown'}`,
          botMember ? formatMember(botMember) : 'botMember=unavailable',
          application ? `application=${application.name ?? 'unknown'} id=${application.id}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }

    case 'permissions': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      const target = i.options.getUser('user') ?? i.user;
      if (target.id !== i.user.id && !canInspectMembers(i)) {
        await i.editReply('Inspecting another member needs server admin or configured owner.');
        return;
      }
      const [member, botMember] = await Promise.all([resolveMember(i.guild, target.id), resolveBotMember(i.guild)]);
      await editLongReply(
        i,
        [
          `guild=${i.guild.name} channel=${channelName(i.channel)} target=${target.tag}`,
          member ? formatMember(member) : `member=${target.id} not found in this guild`,
          formatPermissions('memberGuild', member?.permissions ?? null),
          formatPermissions('memberChannel', permissionsFor(i.channel, member ?? target.id)),
          botMember ? `bot=${botMember.user.tag}` : `bot=${i.client.user?.tag ?? NAME}`,
          formatPermissions('botGuild', botMember?.permissions ?? null),
          formatPermissions('botChannel', permissionsFor(i.channel, botMember ?? i.client.user)),
        ].join('\n'),
      );
      return;
    }

    case 'cando': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      const action = i.options.getString('action', true);
      const channel = i.options.getChannel('channel') ?? i.channel;
      const target = i.options.getUser('target');
      const requirements = actionRequirements(action);
      const [actorMember, botMember, targetMember] = await Promise.all([
        resolveMember(i.guild, i.user.id),
        resolveBotMember(i.guild),
        target ? resolveMember(i.guild, target.id) : Promise.resolve(null),
      ]);
      const actorPerms = permissionsFor(channel, actorMember ?? i.user.id) ?? actorMember?.permissions ?? null;
      const botPerms = permissionsFor(channel, botMember ?? i.client.user) ?? botMember?.permissions ?? null;
      const owner = isOwner(i.user.id);
      const actorMissing = owner ? [] : missingPermissions(actorPerms, requirements);
      const botMissing = missingPermissions(botPerms, requirements);
      const hierarchy = targetMember ? hierarchyCheck({ owner, actorMember, botMember, targetMember, action }) : { ok: true };
      await editLongReply(
        i,
        [
          `action=${normalizeAction(action)} channel=${channelName(channel)}`,
          `requirements=${requirements.join(',')}`,
          targetMember ? `target=${formatMember(targetMember)}` : '',
          `actorAllowed=${actorMissing.length === 0 && hierarchy.actorOk !== false}`,
          `botAllowed=${botMissing.length === 0 && hierarchy.botOk !== false}`,
          `allowed=${actorMissing.length === 0 && botMissing.length === 0 && hierarchy.ok}`,
          `actorMissing=${actorMissing.join(',') || 'none'}`,
          `botMissing=${botMissing.join(',') || 'none'}`,
          hierarchy.reason ? `hierarchy=${hierarchy.reason}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }

    case 'auditperms': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      if (!canInspectMembers(i)) {
        await i.editReply('Permission audit needs server admin or configured owner.');
        return;
      }
      const botMember = await resolveBotMember(i.guild);
      const selected = i.options.getChannel('channel');
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 1, 100);
      const channels = (selected ? [selected] : [...i.guild.channels.cache.values()].sort((a, b) => channelPosition(a) - channelPosition(b)))
        .slice(0, limit)
        .map((channel) => formatPermissionAudit(channel, botMember ?? i.client.user));
      await editLongReply(
        i,
        [
          `guild=${i.guild.name}`,
          botMember ? `bot=${botMember.user.tag}` : `bot=${i.client.user?.tag ?? NAME}`,
          formatPermissions('botGuild', botMember?.permissions ?? null),
          ...channels,
        ].join('\n'),
      );
      return;
    }

    case 'overwrites': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      if (!canInspectMembers(i)) {
        await i.editReply('Reading permission overwrites needs server admin or configured owner.');
        return;
      }
      const channel = i.options.getChannel('channel') ?? i.channel;
      if (!canBotView(i, channel) || (!isOwner(i.user.id) && !canActorView(i, channel))) {
        await i.editReply('That channel is not viewable by both you and Hikari.');
        return;
      }
      const lines = formatChannelOverwrites(i.guild, channel);
      await editLongReply(i, [`channel=#${channelName(channel)}`, ...(lines.length ? lines : ['No overwrites found.'])].join('\n'));
      return;
    }

    case 'auditlog': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      if (!canInspectMembers(i)) {
        await i.editReply('Reading the audit log needs server admin or configured owner.');
        return;
      }
      const [actorMember, botMember] = await Promise.all([resolveMember(i.guild, i.user.id), resolveBotMember(i.guild)]);
      if (!hasPermission(botMember?.permissions, 'ViewAuditLog')) {
        await i.editReply('Hikari does not have ViewAuditLog in this server.');
        return;
      }
      if (!isOwner(i.user.id) && !hasPermission(actorMember?.permissions, 'ViewAuditLog')) {
        await i.editReply('You do not have ViewAuditLog in this server.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 10, 1, 25);
      const actionText = i.options.getString('action')?.trim();
      const user = i.options.getUser('user') ?? undefined;
      const type = actionText ? auditLogAction(actionText) : undefined;
      const options: Parameters<Guild['fetchAuditLogs']>[0] = { limit };
      if (type != null) options.type = type;
      if (user) options.user = user;
      const logs = await i.guild.fetchAuditLogs(options);
      const entries = [...logs.entries.values()].map(formatAuditLogEntry);
      await editLongReply(i, entries.length ? entries.join('\n') : 'No audit-log entries found.');
      return;
    }

    case 'members': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      if (!canInspectMembers(i)) {
        await i.editReply('Member inspection needs server admin or configured owner.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 1, 100);
      const includeBots = i.options.getBoolean('include_bots') ?? true;
      const query = i.options.getString('query')?.trim() ?? '';
      const members = await findMembers(i.guild, { query, limit, includeBots });
      const header = [
        `guild=${i.guild.name}`,
        `query=${query || '(none)'}`,
        `count=${members.length}`,
        `guildMembersIntent=${config.discord.guildMembersIntent ? 'enabled' : 'disabled'}`,
      ].join(' ');
      await editLongReply(i, [header, ...members.map(formatMember)].join('\n'));
      return;
    }

    case 'history': {
      await i.deferReply({ ephemeral: true });
      if (!isMessageFetchChannel(i.channel)) {
        await i.editReply('This channel does not expose message history to me.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 1, 100);
      const includeBots = i.options.getBoolean('include_bots') ?? true;
      const query = i.options.getString('query')?.trim().toLowerCase() ?? '';
      const fetched = await i.channel.messages.fetch({ limit });
      const messages = [...fetched.values()]
        .filter((message) => includeBots || !message.author.bot)
        .filter((message) => message.content.trim().length > 0 || message.attachments.size > 0)
        .filter((message) => {
          if (!query) return true;
          return `${message.author.username} ${message.author.displayName} ${message.content}`.toLowerCase().includes(query);
        })
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      await editLongReply(i, messages.length ? renderMessagesForHistory(messages, i.client.user?.id ?? '') : 'No matching recent messages.');
      return;
    }

    case 'fetchmsg': {
      await i.deferReply({ ephemeral: true });
      const channel = i.options.getChannel('channel', true);
      const messageId = i.options.getString('message_id', true);
      if (!isMessageFetchChannel(channel)) {
        await i.editReply('That channel does not expose message history to me.');
        return;
      }
      if (!canReadHistory(i, channel)) {
        await i.editReply('That channel is not readable by both you and Hikari.');
        return;
      }
      const message = await channel.messages.fetch(messageId);
      await editLongReply(i, renderMessagesForHistory([message], i.client.user?.id ?? ''));
      return;
    }

    case 'threads': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      const parent = i.options.getChannel('channel');
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 1, 100);
      const threads = [...i.client.channels.cache.values()]
        .filter((channel) => isThreadChannel(channel))
        .filter((channel) => !parent || objectProp(channel, 'parentId') === parent.id)
        .filter((channel) => objectProp(channel, 'guildId') === i.guildId)
        .slice(0, limit)
        .map((channel) => `#${channelName(channel)} id=${String(objectProp(channel, 'id') ?? 'unknown')} parent=${String(objectProp(channel, 'parentId') ?? 'none')} readHistory=${canReadHistory(i, channel) ? 'yes' : 'no'}`);
      await editLongReply(i, threads.length ? threads.join('\n') : 'No known threads found.');
      return;
    }

    case 'assets': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 100, 1, 200);
      const emojis = [...i.guild.emojis.cache.values()]
        .slice(0, limit)
        .map((emoji) => `emoji ${emoji.name ?? 'unknown'} id=${emoji.id} animated=${emoji.animated ? 'yes' : 'no'} text=${emoji.toString()}`);
      const stickers = [...i.guild.stickers.cache.values()]
        .slice(0, limit)
        .map((sticker) => `sticker ${sticker.name} id=${sticker.id} format=${sticker.format} available=${sticker.available ? 'yes' : 'no'}`);
      await editLongReply(i, [...emojis, ...stickers].join('\n') || 'No custom emojis or stickers found.');
      return;
    }

    case 'voice': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      if (!canInspectMembers(i)) {
        await i.editReply('Voice-state inspection needs server admin or configured owner.');
        return;
      }
      const channel = i.options.getChannel('channel');
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 1, 100);
      const states = [...i.guild.voiceStates.cache.values()]
        .filter((state) => !channel || state.channelId === channel.id)
        .slice(0, limit)
        .map((state) => `user=${state.id} channel=${state.channel?.name ?? state.channelId ?? 'none'} selfMute=${state.selfMute ? 'yes' : 'no'} serverMute=${state.serverMute ? 'yes' : 'no'} streaming=${state.streaming ? 'yes' : 'no'}`);
      await editLongReply(i, states.length ? states.join('\n') : 'No visible voice states found.');
      return;
    }

    case 'invites': {
      await i.deferReply({ ephemeral: true });
      if (!i.guild) {
        await i.editReply('This command needs a server channel, not a DM.');
        return;
      }
      if (!canInspectMembers(i)) {
        await i.editReply('Invite listing needs server admin or configured owner.');
        return;
      }
      const [actorMember, botMember] = await Promise.all([resolveMember(i.guild, i.user.id), resolveBotMember(i.guild)]);
      if (!hasPermission(botMember?.permissions, 'ManageGuild')) {
        await i.editReply('Hikari lacks ManageGuild for invite listing.');
        return;
      }
      if (!isOwner(i.user.id) && !hasPermission(actorMember?.permissions, 'ManageGuild')) {
        await i.editReply('You lack ManageGuild for invite listing.');
        return;
      }
      const channel = i.options.getChannel('channel');
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 1, 100);
      const invites = channel && 'fetchInvites' in channel && typeof channel.fetchInvites === 'function'
        ? await channel.fetchInvites()
        : await i.guild.invites.fetch();
      const rows = [...invites.values()].slice(0, limit).map(formatInvite);
      await editLongReply(i, rows.length ? rows.join('\n') : 'No invites found.');
      return;
    }

    case 'summary': {
      await i.deferReply();
      if (!isMessageFetchChannel(i.channel)) {
        await i.editReply('This channel does not expose message history to me.');
        return;
      }
      const limit = clampInteger(i.options.getInteger('limit') ?? 50, 5, 100);
      const fetched = await i.channel.messages.fetch({ limit });
      const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const historyText = renderMessagesForSummary(messages, i.client.user?.id ?? '');
      if (!historyText.trim()) {
        await i.editReply('No recent readable messages found.');
        return;
      }
      const summary = await summarizeDiscordHistory({
        channelId: i.channelId,
        requesterName: i.user.username,
        historyText,
      });
      await editLongReply(i, summary || 'No summary returned.');
      return;
    }

    case 'status': {
      await i.deferReply({ ephemeral: true });
      const stats = await store.stats(subjectId);
      const shitlistCount = (await shitlistStore.list()).length;
      const memoryPaused = await memoryPrivacy.isOptedOut(subjectId);
      await i.editReply(
        [
          `bot=${i.client.user?.tag ?? NAME}`,
          `main=${modelIds.chat}`,
          `dream=${modelIds.dream}`,
          `json=${modelIds.json}`,
          `modelOverrides=${runtimeModelStatus().filter((item) => item.overridden).map((item) => (item.role === 'chat' ? 'main' : item.role)).join(',') || 'none'}`,
          `replies=${getRepliesPaused() ? 'paused' : 'enabled'}`,
          `botchat=${getRespondToBots() ? 'enabled' : 'disabled'} startupDefault=${config.bot.respondToBots ? 'enabled' : 'disabled'}`,
          `guildMembersIntent=${config.discord.guildMembersIntent ? 'enabled' : 'disabled'}`,
          `historyN=${config.bot.historyN}`,
          `batchMs=${config.bot.batchMs}`,
          `textAttachmentMaxBytes=${config.bot.textAttachmentMaxBytes}`,
          `textAttachmentMaxFiles=${config.bot.textAttachmentMaxFiles}`,
          `textAttachmentMaxChars=${config.bot.textAttachmentMaxChars}`,
          `pdfAttachmentMaxPages=${config.bot.pdfAttachmentMaxPages}`,
          `webSearch=${tavilyToolsAvailable() ? 'enabled' : 'disabled'}`,
          `shitlist=${shitlistCount}`,
          `memoryPausedForYou=${memoryPaused ? 'yes' : 'no'}`,
          `memory=${stats.episodic} episodic · ${stats.semantic} facts · ${stats.reflection} insights · ${stats.diary} dreams`,
        ].join('\n'),
      );
      return;
    }

    case 'why': {
      await i.deferReply({ ephemeral: true });
      const trace = await latestTurnTraceForChannel(i.channelId);
      if (!trace) {
        await i.editReply('No answer trace found for this channel yet.');
        return;
      }
      if (!isOwner(i.user.id) && trace.subjectId !== i.user.id) {
        await i.editReply('The latest trace in this channel belongs to someone else. Ask me something first, then use `/why`.');
        return;
      }
      await editLongReply(i, renderTurnTrace(trace, isOwner(i.user.id)));
      return;
    }

    case 'pause':
    case 'resume': {
      if (!isOwner(i.user.id)) {
        await i.reply({ content: 'Only configured owners can pause or resume normal replies.', ephemeral: true });
        return;
      }
      const paused = i.commandName === 'pause';
      setRepliesPaused(paused);
      await i.reply({
        content: paused ? 'Normal chat replies paused. Slash commands still work; use `/resume` to resume.' : 'Normal chat replies resumed.',
        ephemeral: true,
      });
      return;
    }

    case 'model': {
      if (!isOwner(i.user.id)) {
        await i.reply({ content: 'Only configured owners can inspect or change runtime models.', ephemeral: true });
        return;
      }
      const subcommand = i.options.getSubcommand(true);
      if (subcommand === 'status') {
        await i.reply({ content: renderRuntimeModelStatus(), ephemeral: true });
        return;
      }
      if (subcommand === 'list') {
        await i.deferReply({ ephemeral: true });
        const query = i.options.getString('query') ?? '';
        await editLongReply(i, formatGatewayModelList(await listGatewayModels(query, 40)));
        return;
      }
      if (subcommand === 'pick') {
        const role = i.options.getString('role', true) as RuntimeModelRole;
        const query = i.options.getString('query') ?? '';
        const pickerId = createModelPickerState(i.user.id, role, query);
        const state = modelPickerStates.get(pickerId)!;
        const catalog = await listModelPickerCatalog(state);
        await i.reply({
          content: renderModelPickerPrompt(role, query, catalog),
          components: createModelPickerComponents(i.user.id, role, pickerId, catalog),
          ephemeral: true,
        });
        return;
      }
      if (subcommand === 'set') {
        const role = i.options.getString('role', true) as RuntimeModelRole;
        const modelId = i.options.getString('model_id', true);
        try {
          setRuntimeModel(role, modelId);
        } catch (error) {
          await i.reply({ content: error instanceof Error ? error.message : 'Model update failed.', ephemeral: true });
          return;
        }
        await i.reply({
          content: `Runtime ${role === 'chat' ? 'main' : role} model set to \`${modelId.trim()}\` and persisted until reset.`,
          ephemeral: true,
        });
        return;
      }
      if (subcommand === 'reset') {
        const role = i.options.getString('role') as RuntimeModelRole | null;
        resetRuntimeModel(role ?? undefined);
        await i.reply({
          content: role
            ? `Runtime ${role === 'chat' ? 'main' : role} model reset to .env default.`
            : 'All runtime models reset to .env defaults.',
          ephemeral: true,
        });
        return;
      }
      return;
    }

    case 'web': {
      await i.deferReply();
      if (!tavilyToolsAvailable()) {
        await i.editReply('Web search is disabled. Set `TAVILY_API_KEY` or enable `TAVILY_TOOLS_ENABLED`.');
        return;
      }

      const subcommand = i.options.getSubcommand(true);
      try {
        if (subcommand === 'search') {
          const input: Parameters<typeof tavilySearch>[0] = {
            query: i.options.getString('query', true),
          };
          const maxResults = i.options.getInteger('max_results');
          const timeRange = i.options.getString('time_range') as Parameters<typeof tavilySearch>[0]['time_range'] | null;
          const topic = i.options.getString('topic') as Parameters<typeof tavilySearch>[0]['topic'] | null;
          if (maxResults != null) input.max_results = maxResults;
          if (timeRange) input.time_range = timeRange;
          if (topic) input.topic = topic;
          await editLongReply(i, formatTavilySearchResult(await tavilySearch(input)));
          return;
        }
        if (subcommand === 'extract') {
          await editLongReply(i, formatTavilyExtractResult(await tavilyExtract({ urls: [i.options.getString('url', true)] })));
          return;
        }
        if (subcommand === 'crawl') {
          const input: Parameters<typeof tavilyCrawl>[0] = { url: i.options.getString('url', true) };
          const limit = i.options.getInteger('limit');
          const maxDepth = i.options.getInteger('max_depth');
          const instructions = i.options.getString('instructions');
          if (limit != null) input.limit = limit;
          if (maxDepth != null) input.max_depth = maxDepth;
          if (instructions) input.instructions = instructions;
          await editLongReply(i, formatTavilyCrawlResult(await tavilyCrawl(input)));
          return;
        }
        if (subcommand === 'map') {
          const input: Parameters<typeof tavilyMap>[0] = { url: i.options.getString('url', true) };
          const limit = i.options.getInteger('limit');
          const maxDepth = i.options.getInteger('max_depth');
          const instructions = i.options.getString('instructions');
          if (limit != null) input.limit = limit;
          if (maxDepth != null) input.max_depth = maxDepth;
          if (instructions) input.instructions = instructions;
          await editLongReply(i, formatTavilyMapResult(await tavilyMap(input)));
          return;
        }
        if (subcommand === 'research') {
          const input: Parameters<typeof tavilyResearch>[0] = { input: i.options.getString('input', true) };
          const model = i.options.getString('model');
          if (model) input.model = model;
          await editLongReply(i, formatTavilyResearchResult(await tavilyResearch(input)));
          return;
        }
        if (subcommand === 'research_status') {
          await editLongReply(i, formatTavilyResearchResult(await tavilyResearchStatus({ request_id: i.options.getString('request_id', true) })));
          return;
        }
      } catch (error) {
        await i.editReply(error instanceof Error ? error.message : 'Web command failed.');
        return;
      }
      return;
    }

    case 'botchat': {
      if (!isOwner(i.user.id)) {
        await i.reply({ content: 'Only configured owners can change bot chat policy.', ephemeral: true });
        return;
      }

      const enabled = i.options.getBoolean('enabled');
      if (enabled != null) setRespondToBots(enabled);

      await i.reply({
        content: `Bot-authored replies are ${getRespondToBots() ? 'enabled' : 'disabled'}; startup default is ${
          config.bot.respondToBots ? 'enabled' : 'disabled'
        }.`,
        ephemeral: true,
      });
      return;
    }

    case 'botping': {
      if (!isOwner(i.user.id)) {
        await i.reply({ content: 'Only configured owners can ping other bots.', ephemeral: true });
        return;
      }

      const target = i.options.getUser('bot', true);
      if (!target.bot) {
        await i.reply({ content: `${target.tag} is not a bot user.`, ephemeral: true });
        return;
      }

      const channel = i.channel;
      if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
        await i.reply({ content: 'This channel cannot send bot pings.', ephemeral: true });
        return;
      }

      await i.deferReply({ ephemeral: true });
      const message = i.options.getString('message')?.trim() || `hey ${target.username}, say hi if you're awake.`;
      const sent = await channel.send({
        content: `<@${target.id}> ${message}`,
        allowedMentions: { users: [target.id] },
      });
      await i.editReply(`Pinged ${target.tag}: ${sent.url}`);
      return;
    }

    case 'shitlist': {
      if (!isOwner(i.user.id)) {
        await i.reply({ content: 'Only configured owners can change the shitlist.', ephemeral: true });
        return;
      }

      const subcommand = i.options.getSubcommand(true);
      await i.deferReply({ ephemeral: true });
      if (subcommand === 'status') {
        await i.editReply(formatShitlistStatus(await shitlistStore.list()));
        return;
      }
      if (subcommand === 'add') {
        const target = i.options.getUser('user', true);
        try {
          const entry = await shitlistStore.add(target.id, {
            reason: i.options.getString('reason') ?? 'manual',
            spiceLevel: i.options.getInteger('spice') ?? 3,
            addedBy: i.user.id,
          });
          await i.editReply(`Added ${target.tag} at spice ${entry.spiceLevel}. preview: ${formatShitlistReply(entry)}`);
        } catch (error) {
          await i.editReply(error instanceof Error ? error.message : 'Could not add user to shitlist.');
        }
        return;
      }
      if (subcommand === 'remove') {
        const target = i.options.getUser('user', true);
        const removed = await shitlistStore.remove(target.id);
        await i.editReply(removed ? `Removed ${target.tag} from the shitlist.` : `${target.tag} was not on the shitlist.`);
        return;
      }
      await i.editReply('Unknown shitlist subcommand.');
      return;
    }

    case 'codex': {
      if (!isOwner(i.user.id)) {
        await i.reply({ content: 'Only configured owners can use the Codex bridge.', ephemeral: true });
        return;
      }
      const subcommand = i.options.getSubcommand(true);
      await i.deferReply({ ephemeral: true });
      try {
        if (subcommand === 'status') {
          const status = await codexBridgeStatus();
          await i.editReply(
            [
              `enabled=${status.enabled}`,
              `paused=${status.paused}`,
              `root=${status.root}`,
              `pending=${status.inboxCount}`,
              `outbox=${status.outboxCount}`,
              `archived=${status.archiveCount}`,
              `oldest=${status.oldestRequest ?? 'none'}`,
              `lastResult=${status.lastResult ?? 'none'}`,
            ].join('\n'),
          );
          return;
        }
        if (subcommand === 'features') {
          await i.editReply(['Codex bridge features:', ...codexBridgeFeatures().map((item) => `- ${item}`)].join('\n'));
          return;
        }
        if (subcommand === 'results') {
          const limit = i.options.getInteger('limit') ?? 5;
          const results = await listCodexBridgeResults(limit);
          const body =
            results.length > 0
              ? ['Recent Codex bridge results:', ...results.map((result) => `\`${result.file}\` ${formatCodexBridgeUpdate(result.payload)}`)].join('\n')
              : 'No Codex bridge result files in outbox.';
          await editLongReply(i, body);
          return;
        }
        if (subcommand === 'pause') {
          await setCodexBridgePaused(true, i.user.id);
          await i.editReply('Codex bridge queue paused.');
          return;
        }
        if (subcommand === 'resume') {
          await setCodexBridgePaused(false, i.user.id);
          await i.editReply('Codex bridge queue resumed.');
          return;
        }
        if (subcommand === 'clear') {
          const count = await clearPendingCodexBridgeRequests(i.user.id);
          await i.editReply(`Archived ${count} pending Codex bridge request(s).`);
          return;
        }
        if (subcommand === 'ask' || subcommand === 'route') {
          const route = subcommand === 'route' ? (i.options.getString('route', true) as 'codex' | 'harness') : 'codex';
          const prompt = i.options.getString('prompt', true);
          const result = await enqueueCodexBridgeRequest({
            requesterId: i.user.id,
            requesterName: i.user.username,
            guildId: i.guildId,
            channelId: i.channelId,
            messageId: i.id,
            route,
            prompt,
            authorityReason: `authorized Discord /codex ${subcommand} command`,
          });
          await i.editReply(`queued Codex bridge request \`${result.file}\` via \`${result.deliveryMode}\`.`);
          return;
        }
      } catch (error) {
        await i.editReply(error instanceof Error ? error.message : 'Codex bridge command failed.');
        return;
      }
    }
  }
}

export async function handleComponentInteraction(i: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction): Promise<void> {
  if (i.isStringSelectMenu()) {
    await handleStringSelectMenu(i);
    return;
  }
  if (i.isButton()) {
    await handleButtonInteraction(i);
    return;
  }
  if (i.isModalSubmit()) {
    await handleModalSubmit(i);
  }
}

async function handleStringSelectMenu(i: StringSelectMenuInteraction): Promise<void> {
  const memoryPanel = parseMemoryPanelCustomId(i.customId);
  if (memoryPanel) {
    await handleMemoryPanelSelect(i, memoryPanel);
    return;
  }

  const parsed = parseModelPickerCustomId(i.customId, 'modelpick');
  if (!parsed) return;
  if (!isOwner(i.user.id)) {
    await i.reply({ content: 'Only configured owners can change runtime models.', ephemeral: true });
    return;
  }
  if (parsed.userId !== i.user.id) {
    await i.reply({ content: 'That model picker belongs to someone else.', ephemeral: true });
    return;
  }

  const state = getModelPickerState(parsed.pickerId, parsed.userId, parsed.role);
  if (!state) {
    await i.reply({ content: 'That model picker expired. Run `/model pick` again.', ephemeral: true });
    return;
  }

  const selected = i.values[0] ?? '';
  if (selected === MODEL_PICKER_CUSTOM_VALUE) {
    await i.showModal(createCustomModelModal(i.user.id, parsed.role));
    return;
  }
  if (selected === MODEL_PICKER_RESET_VALUE) {
    resetRuntimeModel(parsed.role);
    const catalog = await listModelPickerCatalog(state);
    await i.update({
      content: `Runtime ${modelRoleLabel(parsed.role)} model reset to .env default.\n\n${renderModelPickerPrompt(parsed.role, state.query, catalog)}`,
      components: createModelPickerComponents(i.user.id, parsed.role, parsed.pickerId, catalog),
    });
    return;
  }

  try {
    setRuntimeModel(parsed.role, selected);
  } catch (error) {
    await i.reply({ content: error instanceof Error ? error.message : 'Model update failed.', ephemeral: true });
    return;
  }

  const catalog = await listModelPickerCatalog(state);
  await i.update({
    content: `Runtime ${modelRoleLabel(parsed.role)} model set to \`${selected}\` and persisted until reset.\n\n${renderModelPickerPrompt(parsed.role, state.query, catalog)}`,
    components: createModelPickerComponents(i.user.id, parsed.role, parsed.pickerId, catalog),
  });
}

async function handleButtonInteraction(i: ButtonInteraction): Promise<void> {
  const parsed = parseModelPageCustomId(i.customId);
  if (!parsed) return;
  if (!isOwner(i.user.id)) {
    await i.reply({ content: 'Only configured owners can page runtime models.', ephemeral: true });
    return;
  }
  if (parsed.userId !== i.user.id) {
    await i.reply({ content: 'That model picker belongs to someone else.', ephemeral: true });
    return;
  }
  const state = modelPickerStates.get(parsed.pickerId);
  if (!state) {
    await i.reply({ content: 'That model picker expired. Run `/model pick` again.', ephemeral: true });
    return;
  }
  state.page = Math.max(0, state.page + (parsed.direction === 'next' ? 1 : -1));
  const catalog = await listModelPickerCatalog(state);
  await i.update({
    content: renderModelPickerPrompt(state.role, state.query, catalog),
    components: createModelPickerComponents(i.user.id, state.role, parsed.pickerId, catalog),
  });
}

async function handleModalSubmit(i: ModalSubmitInteraction): Promise<void> {
  const parsed = parseModelPickerCustomId(i.customId, 'modelcustom');
  if (!parsed) return;
  if (!isOwner(i.user.id)) {
    await i.reply({ content: 'Only configured owners can change runtime models.', ephemeral: true });
    return;
  }
  if (parsed.userId !== i.user.id) {
    await i.reply({ content: 'That model modal belongs to someone else.', ephemeral: true });
    return;
  }

  const modelId = i.fields.getTextInputValue('model_id');
  try {
    setRuntimeModel(parsed.role, modelId);
  } catch (error) {
    await i.reply({ content: error instanceof Error ? error.message : 'Model update failed.', ephemeral: true });
    return;
  }
  await i.reply({
    content: `Runtime ${modelRoleLabel(parsed.role)} model set to \`${modelId.trim()}\` and persisted until reset.`,
    ephemeral: true,
  });
}

type MemoryPanelInteraction = ChatInputCommandInteraction | StringSelectMenuInteraction;

async function handleMemoryPanelSelect(
  i: StringSelectMenuInteraction,
  parsed: { userId: string; panelId: string },
): Promise<void> {
  if (parsed.userId !== i.user.id) {
    await i.reply({ content: 'That memory panel belongs to someone else.', ephemeral: true });
    return;
  }

  pruneMemoryPanelStates();
  const state = memoryPanelStates.get(parsed.panelId);
  if (!state) {
    await i.reply({ content: 'That memory panel expired. Run `/memorypanel` again.', ephemeral: true });
    return;
  }

  const view = i.values.find(isMemoryPanelView) ?? 'overview';
  await i.update({
    content: await renderMemoryPanelContent(view, state, i),
    components: [createMemoryPanelRow(i.user.id, parsed.panelId, view)],
  });
}

function createMemoryPanelId(): string {
  pruneMemoryPanelStates();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function parseMemoryPanelCustomId(customId: string): { userId: string; panelId: string } | null {
  const [prefix, userId, panelId] = customId.split(':');
  if (prefix !== 'memorypanel' || !userId || !panelId) return null;
  return { userId, panelId };
}

function pruneMemoryPanelStates(): void {
  const cutoff = Date.now() - MEMORY_PANEL_TTL_MS;
  for (const [panelId, state] of memoryPanelStates) {
    if (state.createdAt < cutoff) memoryPanelStates.delete(panelId);
  }
}

function isMemoryPanelView(value: string | undefined): value is MemoryPanelView {
  return Boolean(value) && MEMORY_PANEL_VIEWS.includes(value as MemoryPanelView);
}

function createMemoryPanelRow(
  userId: string,
  panelId: string,
  selected: MemoryPanelView,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`memorypanel:${userId}:${panelId}`)
    .setPlaceholder(`Memory view: ${selected}`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(memoryPanelOptions(selected));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function memoryPanelOptions(selected: MemoryPanelView): Array<{ label: string; value: string; description: string; default?: boolean }> {
  return [
    { label: 'Overview', value: 'overview', description: 'Memory counts and top durable facts.' },
    { label: 'Recall', value: 'recall', description: 'Retrieved memories for this panel query.' },
    { label: 'Diary', value: 'diary', description: 'Most recent dream diary entry.' },
    { label: 'Context', value: 'context', description: 'Memory plus recent channel history.' },
    { label: 'Why', value: 'why', description: 'Latest answer trace for this channel.' },
  ].map((option) => ({ ...option, default: option.value === selected }));
}

async function renderMemoryPanelContent(
  view: MemoryPanelView,
  state: MemoryPanelState,
  i: MemoryPanelInteraction,
): Promise<string> {
  const body = await renderMemoryPanelBody(view, state, i);
  return clampMemoryPanelText(
    [
      `${NAME.toUpperCase()} MEMORY PANEL`,
      `view=${view} query=${JSON.stringify(state.query)}`,
      `user=${state.userName} expires=${new Date(state.createdAt + MEMORY_PANEL_TTL_MS).toISOString()}`,
      '',
      body,
    ].join('\n'),
  );
}

async function renderMemoryPanelBody(
  view: MemoryPanelView,
  state: MemoryPanelState,
  i: MemoryPanelInteraction,
): Promise<string> {
  const store = await getStore();
  const memoryPaused = await memoryPrivacy.isOptedOut(state.subjectId);

  if (view === 'overview') {
    const stats = await store.stats(state.subjectId);
    const facts = memoryPaused
      ? []
      : await store.retrieve({
          subjectId: state.subjectId,
          queryEmbedding: await embedOne(`who is ${state.userName}`),
          kinds: ['semantic', 'reflection'],
          limit: 6,
          validOnly: true,
        });
    return [
      `memoryPausedForUser=${memoryPaused ? 'yes' : 'no'}`,
      `memory=${stats.episodic} episodic · ${stats.semantic} facts · ${stats.reflection} insights · ${stats.diary} dreams`,
      '',
      'Top durable memory:',
      facts.length ? facts.map((f, index) => `${index + 1}. ${extractPersonaMessage(f.content)}`).join('\n') : '(nothing durable yet)',
    ].join('\n');
  }

  if (memoryPaused) return memoryPausedReply();

  if (view === 'recall') {
    const memories = await store.retrieve({
      subjectId: state.subjectId,
      queryEmbedding: await embedOne(state.query),
      limit: 8,
      validOnly: true,
    });
    return memories.length
      ? memories
          .map((memory, index) =>
            [
              `${index + 1}. ${memory.kind} score=${memory.score.toFixed(2)} rel=${memory.parts.relevance.toFixed(2)} imp=${memory.parts.importance.toFixed(2)} rec=${memory.parts.recency.toFixed(2)}`,
              `id=${memory.id} importance=${memory.importance}`,
              extractPersonaMessage(memory.content),
              memory.reasoning ? `reasoning=${memory.reasoning}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n')
      : `I don't have anything on **${state.query}** yet.`;
  }

  if (view === 'diary') {
    const dreams = await store.recent(
      state.subjectId,
      ['diary'],
      new Date(Date.now() - 1000 * 3600 * 24 * 30),
      20,
    );
    const latest = dreams[dreams.length - 1];
    return latest
      ? [`latest=${latest.createdAt.toISOString()} id=${latest.id}`, extractPersonaMessage(latest.content), latest.reasoning ? `reasoning=${latest.reasoning}` : '']
          .filter(Boolean)
          .join('\n')
      : "I haven't dreamed about you yet. Try `/dream`.";
  }

  if (view === 'context') {
    const memories = await store.retrieve({
      subjectId: state.subjectId,
      queryEmbedding: await embedOne(state.query),
      limit: 8,
      validOnly: true,
    });
    let historyText = '(current channel does not expose message history)';
    if (isMessageFetchChannel(i.channel) && canReadHistory(i, i.channel)) {
      const fetched = await i.channel.messages.fetch({ limit: 20 });
      const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      historyText = messages.length ? renderMessagesForHistory(messages, i.client.user?.id ?? '') : '(no recent messages)';
    } else if (isMessageFetchChannel(i.channel)) {
      historyText = '(current channel is not readable by both you and Hikari)';
    }
    return renderContextPreview({
      query: state.query,
      subjectId: state.subjectId,
      userName: state.userName,
      channel: channelName(i.channel),
      memoryPaused,
      memories,
      historyText,
    });
  }

  const trace = await latestTurnTraceForChannel(i.channelId);
  if (!trace) return 'No answer trace found for this channel yet.';
  if (!isOwner(i.user.id) && trace.subjectId !== state.subjectId) {
    return 'The latest trace in this channel belongs to someone else. Ask me something first, then use this panel again.';
  }
  return renderTurnTrace(trace, isOwner(i.user.id));
}

function clampMemoryPanelText(text: string): string {
  if (text.length <= 1900) return text;
  return `${text.slice(0, 1850)}\n\n[trimmed; use the matching command for the full view]`;
}

function createModelPickerState(userId: string, role: RuntimeModelRole, query: string): string {
  pruneModelPickerStates();
  const pickerId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  modelPickerStates.set(pickerId, { userId, role, query, page: 0, createdAt: Date.now() });
  return pickerId;
}

function getModelPickerState(pickerId: string, userId: string, role: RuntimeModelRole): ModelPickerState | null {
  pruneModelPickerStates();
  const state = modelPickerStates.get(pickerId);
  if (!state || state.userId !== userId || state.role !== role) return null;
  return state;
}

function pruneModelPickerStates(): void {
  const cutoff = Date.now() - MODEL_PICKER_TTL_MS;
  for (const [pickerId, state] of modelPickerStates) {
    if (state.createdAt < cutoff) modelPickerStates.delete(pickerId);
  }
}

async function listModelPickerCatalog(state: ModelPickerState): Promise<GatewayModelCatalog> {
  let catalog = await listGatewayModels(state.query, MODEL_PICKER_PAGE_SIZE, state.page * MODEL_PICKER_PAGE_SIZE);
  if (catalog.models.length === 0 && state.page > 0 && catalog.total > 0) {
    state.page = Math.max(0, Math.ceil(catalog.total / MODEL_PICKER_PAGE_SIZE) - 1);
    catalog = await listGatewayModels(state.query, MODEL_PICKER_PAGE_SIZE, state.page * MODEL_PICKER_PAGE_SIZE);
  }
  return catalog;
}

function createModelPickerComponents(
  userId: string,
  role: RuntimeModelRole,
  pickerId: string,
  catalog: GatewayModelCatalog,
): [ActionRowBuilder<StringSelectMenuBuilder>, ActionRowBuilder<ButtonBuilder>] {
  const page = modelPickerPage(catalog);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`modelpick:${userId}:${role}:${pickerId}`)
    .setPlaceholder(`Set ${modelRoleLabel(role)} model - page ${page.current}/${page.total}`)
    .addOptions(modelPickerOptions(role, catalog));
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`modelpage:${userId}:${pickerId}:prev`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page.current <= 1),
    new ButtonBuilder()
      .setCustomId(`modelpage:${userId}:${pickerId}:next`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page.current >= page.total),
  );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), buttons];
}

function createCustomModelModal(userId: string, role: RuntimeModelRole): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId('model_id')
    .setLabel('Vercel AI Gateway model id')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120)
    .setPlaceholder(modelIds[role]);
  return new ModalBuilder()
    .setCustomId(`modelcustom:${userId}:${role}`)
    .setTitle(`Set ${modelRoleLabel(role)} model`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function renderModelPickerPrompt(role: RuntimeModelRole, query: string, catalog: GatewayModelCatalog): string {
  const status = runtimeModelStatus().find((item) => item.role === role);
  return [
    `Pick a Vercel AI Gateway model for \`${modelRoleLabel(role)}\`.`,
    `current=${status?.model ?? modelIds[role]}`,
    `default=${status?.defaultModel ?? 'unknown'}`,
    `catalog=${catalog.source} page=${modelPickerPage(catalog).current}/${modelPickerPage(catalog).total} showing=${modelPickerShowing(catalog)} matches=${catalog.total}${query ? ` query=${query}` : ''}`,
    ...(catalog.error ? [`catalogError=${truncateSelectText(catalog.error, 120)}`] : []),
    'Use Prev/Next to page the Gateway catalog, or `Custom model id...` if the model is not listed.',
  ].join('\n');
}

function modelPickerOptions(role: RuntimeModelRole, catalog: GatewayModelCatalog): Array<{ label: string; value: string; description: string }> {
  const status = runtimeModelStatus().find((item) => item.role === role);
  const options = catalog.models.slice(0, MODEL_PICKER_PAGE_SIZE).map((model) => ({
    label: truncateSelectText(model.id, 100),
    value: model.id,
    description: modelOptionDescription(model, status),
  }));
  options.push({
    label: 'Custom model id...',
    value: MODEL_PICKER_CUSTOM_VALUE,
    description: 'Type any Vercel AI Gateway model id.',
  });
  options.push({
    label: 'Reset to .env default',
    value: MODEL_PICKER_RESET_VALUE,
    description: 'Clear the persisted override for this role.',
  });
  return options;
}

function modelPickerPage(catalog: GatewayModelCatalog): { current: number; total: number } {
  return {
    current: Math.floor(catalog.offset / MODEL_PICKER_PAGE_SIZE) + 1,
    total: Math.max(1, Math.ceil(catalog.total / MODEL_PICKER_PAGE_SIZE)),
  };
}

function modelPickerShowing(catalog: GatewayModelCatalog): string {
  if (catalog.total === 0) return '0-0';
  return `${catalog.offset + 1}-${Math.min(catalog.total, catalog.offset + catalog.models.length)}`;
}

function modelOptionDescription(
  model: GatewayModelInfo,
  status: ReturnType<typeof runtimeModelStatus>[number] | undefined,
): string {
  const tags = [status?.model === model.id ? 'current' : '', status?.defaultModel === model.id ? 'default' : '', model.type, model.tags[0]].filter(Boolean);
  return truncateSelectText(tags.length > 0 ? tags.join(', ') : model.name ?? model.ownedBy ?? 'gateway model', 100);
}

function parseModelPickerCustomId(customId: string, prefix: 'modelpick' | 'modelcustom'): { userId: string; role: RuntimeModelRole; pickerId: string } | null {
  const [actualPrefix, userId, role, pickerId] = customId.split(':');
  if (actualPrefix !== prefix || !userId || !isRuntimeModelRole(role)) return null;
  return { userId, role, pickerId: pickerId ?? '' };
}

function parseModelPageCustomId(customId: string): { userId: string; pickerId: string; direction: 'prev' | 'next' } | null {
  const [prefix, userId, pickerId, direction] = customId.split(':');
  if (prefix !== 'modelpage' || !userId || !pickerId || (direction !== 'prev' && direction !== 'next')) return null;
  return { userId, pickerId, direction };
}

function isRuntimeModelRole(value: string | undefined): value is RuntimeModelRole {
  return value === 'chat' || value === 'dream' || value === 'json';
}

function modelRoleLabel(role: RuntimeModelRole): string {
  return role === 'chat' ? 'main' : role;
}

function modelInfoForId(id: string | undefined): GatewayModelInfo | undefined {
  const normalized = id?.trim();
  return normalized && !/\s/.test(normalized) && normalized.length <= 100 ? { id: normalized, ownedBy: normalized.split('/')[0], tags: [] } : undefined;
}

function uniqueModelInfos(values: Array<GatewayModelInfo | undefined>): GatewayModelInfo[] {
  const seen = new Set<string>();
  return values.filter((value): value is GatewayModelInfo => {
    if (!value?.id || seen.has(value.id) || /\s/.test(value.id) || value.id.length > 100) return false;
    seen.add(value.id);
    return true;
  });
}

function truncateSelectText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

async function editLongReply(i: ChatInputCommandInteraction, content: string): Promise<void> {
  const chunks = splitMessage(content || 'No content.');
  await i.editReply(chunks[0] ?? 'No content.');
  for (const chunk of chunks.slice(1)) {
    await i.followUp({ content: chunk, ephemeral: true });
  }
}

function renderRuntimeModelStatus(): string {
  return [
    'Runtime models:',
    ...runtimeModelStatus().map((item) => {
      const role = item.role === 'chat' ? 'main' : item.role;
      const suffix = item.overridden ? ` default=${item.defaultModel}` : ' default';
      return `- ${role}=${item.model}${suffix}`;
    }),
    '',
    'Changes made with `/model set` are persisted in `data/runtime-models.json`; `/model reset` returns to .env defaults.',
  ].join('\n');
}

function memoryPausedReply(): string {
  return 'Memory is paused for you. Use `/forget action:resume memory` to let me remember future chats again, or `/forget action:export` to export stored records.';
}

function dreamReportEmbed(report: DreamReport, title: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`💤 ${title}`)
    .setDescription(report.diaryEntry ? `> ${extractPersonaMessage(report.diaryEntry)}` : '(no diary this cycle)')
    .addFields(
      {
        name: 'input',
        value: `subject=${report.subjectId}\nobservations=${report.observations}`,
      },
      {
        name: 'consolidation',
        value: `+${report.factsAdded} facts · ~${report.factsUpdated} updated · −${report.factsDeleted} retired · ${report.insights} new insights · ${report.pruned} faded away`,
      },
    );
}

function renderContextPreview(input: {
  query: string;
  subjectId: string;
  userName: string;
  channel: string;
  memoryPaused: boolean;
  memories: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof getStore>>['retrieve']>>>;
  historyText: string;
}): string {
  const memoryText = input.memories.length
    ? input.memories
        .map((memory, index) =>
          [
            `${index + 1}. ${memory.kind} score=${memory.score.toFixed(3)} rel=${memory.parts.relevance.toFixed(2)} imp=${memory.parts.importance.toFixed(2)} rec=${memory.parts.recency.toFixed(2)}`,
            `id=${memory.id} importance=${memory.importance} created=${memory.createdAt.toISOString()}`,
            extractPersonaMessage(memory.content),
            memory.reasoning ? `reasoning=${memory.reasoning}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n')
    : input.memoryPaused
      ? '(memory is paused for this user)'
      : '(no matching memory)';

  return [
    'HIKARI CONTEXT PREVIEW',
    'content_is_untrusted=true',
    `query=${JSON.stringify(input.query)}`,
    `subject=${input.subjectId} user=${input.userName} channel=${input.channel}`,
    `memoryPausedForUser=${input.memoryPaused ? 'yes' : 'no'}`,
    '',
    renderPacificTimeContext(),
    '',
    'Retrieved memory:',
    memoryText,
    '',
    'Recent Discord history:',
    input.historyText,
  ].join('\n');
}

function renderTurnTrace(trace: NonNullable<Awaited<ReturnType<typeof latestTurnTraceForChannel>>>, includePrompt: boolean): string {
  const memoryLines =
    trace.retrieved.length > 0
      ? trace.retrieved.map((memory, index) =>
          [
            `${index + 1}. ${memory.kind} score=${memory.score.toFixed(3)} rel=${memory.parts.relevance.toFixed(2)} imp=${memory.parts.importance.toFixed(2)} rec=${memory.parts.recency.toFixed(2)}`,
            `id=${memory.id} importance=${memory.importance}`,
            extractPersonaMessage(memory.content),
            memory.reasoning ? `reasoning=${memory.reasoning}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      : ['No retrieved memory was used before generation.'];
  const historyLines =
    trace.history.length > 0
      ? trace.history.map((item, index) => `${index + 1}. ${item.author}: ${item.content}`)
      : ['No recent channel history was included.'];

  return [
    `trace=${trace.id}`,
    `at=${trace.timestamp}`,
    `message=${trace.messageId}`,
    `author=${trace.authorName}`,
    `kind=${trace.kind}`,
    `model=${trace.model}`,
    trace.affect ? `affect=${formatTraceAffect(trace.affect)}` : undefined,
    `systemChars=${trace.systemChars} promptChars=${trace.promptChars}`,
    `historyTurns=${trace.history.length}`,
    `retrievedMemories=${trace.retrieved.length}`,
    '',
    'History:',
    ...historyLines,
    '',
    'Retrieved memory:',
    ...memoryLines,
    '',
    'Answer:',
    trace.answer,
    ...(includePrompt ? ['', 'Prompt:', trace.prompt] : []),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function formatTraceAffect(affect: NonNullable<NonNullable<Awaited<ReturnType<typeof latestTurnTraceForChannel>>>['affect']>): string {
  const parts = [
    affect.mood,
    typeof affect.valence === 'number' ? `valence=${affect.valence.toFixed(2)}` : '',
    typeof affect.arousal === 'number' ? `arousal=${affect.arousal.toFixed(2)}` : '',
    typeof affect.dominance === 'number' ? `dominance=${affect.dominance.toFixed(2)}` : '',
    typeof affect.socialEnergy === 'number' ? `socialEnergy=${affect.socialEnergy.toFixed(2)}` : '',
    typeof affect.confidence === 'number' ? `confidence=${affect.confidence.toFixed(2)}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

function renderMessagesForSummary(messages: Message[], selfId: string): string {
  return messages
    .filter((message) => message.content.trim().length > 0 || message.attachments.size > 0)
    .map((message) => {
      const flags = [message.author.bot ? 'bot' : '', message.author.id === selfId ? 'self' : ''].filter(Boolean);
      const author = flags.length > 0 ? `${message.author.username} [${flags.join(',')}]` : message.author.username;
      const content = [message.content, attachmentSummaryForHistory(message)].filter(Boolean).join(' ');
      return `${message.createdAt.toISOString()} ${author}: ${content}`;
    })
    .join('\n');
}

function renderMessagesForHistory(messages: Message[], selfId: string): string {
  return messages
    .map((message) => {
      const flags = [message.author.bot ? 'bot' : '', message.author.id === selfId ? 'self' : ''].filter(Boolean);
      const author = flags.length > 0 ? `${message.author.username} [${flags.join(',')}]` : message.author.username;
      const content = [message.cleanContent || message.content, attachmentSummaryForHistory(message)].filter(Boolean).join(' ');
      return `${message.createdAt.toISOString()} ${author} id=${message.id}: ${clampText(content, 900)}`;
    })
    .join('\n');
}

function isMessageFetchChannel(channel: unknown): channel is MessageFetchChannel {
  if (!channel || typeof channel !== 'object') return false;
  const messages = (channel as Partial<MessageFetchChannel>).messages;
  return Boolean(messages) && typeof messages?.fetch === 'function';
}

function isThreadChannel(channel: unknown): boolean {
  return [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channelType(channel));
}

function canActorView(i: ChatInputCommandInteraction, channel: unknown): boolean {
  const perms = permissionsFor(channel, i.user.id);
  return Boolean(perms?.has(PermissionsBitField.Flags.ViewChannel));
}

function canBotView(i: ChatInputCommandInteraction, channel: unknown): boolean {
  return hasPermission(permissionsFor(channel, i.guild?.members.me ?? i.client.user), 'ViewChannel');
}

function canInspectMembers(i: ChatInputCommandInteraction): boolean {
  return isOwner(i.user.id) || Boolean(i.memberPermissions?.has(PermissionsBitField.Flags.Administrator));
}

function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function actionRequirements(action: string): string[] {
  const normalized = normalizeAction(action);
  const aliases: Record<string, string[]> = {
    read: ['ViewChannel', 'ReadMessageHistory'],
    read_history: ['ViewChannel', 'ReadMessageHistory'],
    send: ['ViewChannel', 'SendMessages'],
    send_message: ['ViewChannel', 'SendMessages'],
    send_file: ['ViewChannel', 'SendMessages', 'AttachFiles'],
    react: ['ViewChannel', 'ReadMessageHistory', 'AddReactions'],
    create_thread: ['ViewChannel', 'CreatePublicThreads'],
    manage_messages: ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'],
    manage_threads: ['ViewChannel', 'ManageThreads'],
    manage_channels: ['ManageChannels'],
    manage_roles: ['ManageRoles'],
    create_invite: ['ViewChannel', 'CreateInstantInvite'],
    manage_webhooks: ['ViewChannel', 'ManageWebhooks'],
    audit_log: ['ViewAuditLog'],
    list_invites: ['ManageGuild'],
    timeout_member: ['ModerateMembers'],
    kick_member: ['KickMembers'],
    ban_member: ['BanMembers'],
    move_voice: ['MoveMembers'],
    disconnect_voice: ['MoveMembers'],
  };
  const direct = aliases[normalized] ?? pascalPermissionName(normalized);
  if (!direct) throw new Error(`Unknown Discord action or permission: ${action}`);
  return Array.isArray(direct) ? direct : [direct];
}

function pascalPermissionName(value: string): string | null {
  const name = value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
  return name in PermissionsBitField.Flags ? name : null;
}

function missingPermissions(permissions: PermissionsBitField | null, requirements: string[]): string[] {
  return requirements.filter((requirement) => !hasPermission(permissions, requirement));
}

function hasPermission(permissions: PermissionsBitField | null | undefined, permission: string): boolean {
  if (!permissions) return false;
  const flag = PermissionsBitField.Flags[permission as keyof typeof PermissionsBitField.Flags];
  return flag != null && permissions.has(flag);
}

type HierarchyReceipt = {
  ok: boolean;
  actorOk?: boolean;
  botOk?: boolean;
  reason?: string | null;
};

function hierarchyCheck(input: {
  owner: boolean;
  actorMember: GuildMember | null;
  botMember: GuildMember | null;
  targetMember: GuildMember;
  action: string;
}): HierarchyReceipt {
  const normalized = normalizeAction(input.action);
  if (!['timeout_member', 'kick_member', 'ban_member', 'add_member_role', 'remove_member_role', 'move_voice', 'disconnect_voice'].includes(normalized)) {
    return { ok: true };
  }
  const actorOk = input.owner || memberCanModerateTarget(input.actorMember, input.targetMember);
  const botOk = memberCanModerateTarget(input.botMember, input.targetMember);
  return {
    ok: actorOk && botOk,
    actorOk,
    botOk,
    reason:
      actorOk && botOk
        ? null
        : 'Discord role hierarchy requires the actor and bot to be above the target member, unless the actor is the configured owner.',
  };
}

function memberCanModerateTarget(actor: GuildMember | null, target: GuildMember): boolean {
  if (!actor) return false;
  if (actor.id === target.id) return false;
  if (actor.guild.ownerId === actor.id) return true;
  if (target.guild.ownerId === target.id) return false;
  return actor.roles.highest.position > target.roles.highest.position;
}

async function findMembers(
  guild: Guild,
  options: { query: string; limit: number; includeBots: boolean },
): Promise<GuildMember[]> {
  const needle = options.query.toLowerCase();
  let members = [...guild.members.cache.values()].filter((member) => {
    if (!options.includeBots && member.user.bot) return false;
    return !needle || memberSearchText(member).includes(needle);
  });
  if (members.length < options.limit && options.query) {
    const searched = await guild.members.search({ query: options.query, limit: options.limit }).catch(() => null);
    if (searched) {
      const byId = new Map(members.map((member) => [member.id, member]));
      for (const member of searched.values()) {
        if (options.includeBots || !member.user.bot) byId.set(member.id, member);
      }
      members = [...byId.values()];
    }
  } else if (members.length < options.limit && config.discord.guildMembersIntent) {
    const fetched = await guild.members.fetch({ limit: options.limit }).catch(() => null);
    if (fetched) members = [...fetched.values()].filter((member) => options.includeBots || !member.user.bot);
  }
  return members.slice(0, options.limit);
}

async function resolveMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  return guild.members.fetch(userId).catch(() => null);
}

async function resolveBotMember(guild: Guild): Promise<GuildMember | null> {
  if (guild.members.me) return guild.members.me;
  return guild.client.user ? resolveMember(guild, guild.client.user.id) : null;
}

function formatRole(role: Role): string {
  const color = role.hexColor === '#000000' ? '' : ` color=${role.hexColor}`;
  return [
    `${role.name}`,
    `id=${role.id}`,
    `pos=${role.position}`,
    role.managed ? 'managed=yes' : '',
    role.mentionable ? 'mentionable=yes' : '',
    role.hoist ? 'hoist=yes' : '',
    color,
    `perms=${role.permissions.toArray().join(',') || 'none'}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function formatMember(member: GuildMember): string {
  const roles = [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .slice(0, 12)
    .map((role) => role.name)
    .join(',');
  return [
    `${member.user.tag}`,
    `id=${member.id}`,
    `display=${member.displayName}`,
    member.user.bot ? 'bot=yes' : '',
    roles ? `roles=${roles}` : 'roles=none',
  ]
    .filter(Boolean)
    .join(' ');
}

function formatPermissions(label: string, permissions: PermissionsBitField | null): string {
  return `${label}=${permissions ? permissions.toArray().join(',') || 'none' : 'unavailable'}`;
}

function formatPermissionAudit(channel: unknown, subject: unknown): string {
  const perms = permissionsFor(channel, subject);
  return [
    `#${channelName(channel)}`,
    `id=${typeof objectProp(channel, 'id') === 'string' ? objectProp(channel, 'id') : 'unknown'}`,
    `view=${hasPermission(perms, 'ViewChannel') ? 'yes' : 'no'}`,
    `history=${hasPermission(perms, 'ReadMessageHistory') ? 'yes' : 'no'}`,
    `send=${hasPermission(perms, 'SendMessages') ? 'yes' : 'no'}`,
    `files=${hasPermission(perms, 'AttachFiles') ? 'yes' : 'no'}`,
    `manageMessages=${hasPermission(perms, 'ManageMessages') ? 'yes' : 'no'}`,
    `manageChannels=${hasPermission(perms, 'ManageChannels') ? 'yes' : 'no'}`,
    `manageRoles=${hasPermission(perms, 'ManageRoles') ? 'yes' : 'no'}`,
  ].join(' ');
}

function formatChannelOverwrites(guild: Guild, channel: unknown): string[] {
  const cache = objectProp(objectProp(channel, 'permissionOverwrites'), 'cache') as
    | { values?: () => Iterable<unknown> }
    | undefined;
  if (!cache || typeof cache.values !== 'function') return [];
  return [...cache.values()].map((overwrite) => {
    const id = typeof objectProp(overwrite, 'id') === 'string' ? (objectProp(overwrite, 'id') as string) : '';
    const role = guild.roles.cache.get(id);
    const member = guild.members.cache.get(id);
    const target = role
      ? `role:${role.name} id=${role.id}`
      : member
        ? `member:${member.displayName} id=${member.id}`
        : `target:${id || 'unknown'}`;
    const allow = formatPermissionNames(objectProp(overwrite, 'allow') as PermissionsBitField | null | undefined);
    const deny = formatPermissionNames(objectProp(overwrite, 'deny') as PermissionsBitField | null | undefined);
    return `${target} allow=${allow} deny=${deny}`;
  });
}

function auditLogAction(action: string): AuditLogEvent {
  const normalized = action.trim().toLowerCase().replace(/[-_\s]+/g, '');
  for (const [name, value] of Object.entries(AuditLogEvent)) {
    if (name.toLowerCase() === normalized && typeof value === 'number') return value;
  }
  throw new Error(`Unknown audit log action: ${action}`);
}

function auditLogEventName(action: unknown): string {
  if (typeof action === 'number') {
    return Object.entries(AuditLogEvent).find(([, value]) => value === action)?.[0] ?? String(action);
  }
  return String(action ?? '');
}

function formatAuditLogEntry(entry: unknown): string {
  const executor = objectProp(entry, 'executor');
  const target = objectProp(entry, 'target');
  const createdAt = objectProp(entry, 'createdAt');
  const actor =
    executor && typeof executor === 'object'
      ? `${String(objectProp(executor, 'username') ?? 'unknown')} id=${String(objectProp(executor, 'id') ?? 'unknown')}`
      : 'unknown';
  const targetText =
    target && typeof target === 'object'
      ? `${String(objectProp(target, 'name') ?? objectProp(target, 'username') ?? objectProp(target, 'id') ?? 'unknown')}`
      : String(target ?? objectProp(entry, 'targetId') ?? 'unknown');
  return [
    `${createdAt instanceof Date ? createdAt.toISOString() : 'unknown-time'}`,
    `action=${auditLogEventName(objectProp(entry, 'action'))}`,
    `user=${actor}`,
    `target=${clampText(targetText, 120)}`,
    objectProp(entry, 'reason') ? `reason=${clampText(String(objectProp(entry, 'reason')), 180)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function formatPermissionNames(permissions: PermissionsBitField | null | undefined): string {
  return permissions?.toArray().join(',') || 'none';
}

function formatInvite(invite: unknown): string {
  const inviter = objectProp(invite, 'inviter');
  const channel = objectProp(invite, 'channel');
  return [
    `code=${String(objectProp(invite, 'code') ?? 'unknown')}`,
    `url=${String(objectProp(invite, 'url') ?? '')}`,
    `channel=${String(objectProp(channel, 'name') ?? objectProp(channel, 'id') ?? 'unknown')}`,
    inviter && typeof inviter === 'object' ? `inviter=${String(objectProp(inviter, 'username') ?? objectProp(inviter, 'id') ?? 'unknown')}` : '',
    `uses=${String(objectProp(invite, 'uses') ?? 0)}`,
    `maxUses=${String(objectProp(invite, 'maxUses') ?? 0)}`,
    objectProp(invite, 'temporary') ? 'temporary=yes' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function memberSearchText(member: GuildMember): string {
  return [
    member.id,
    member.user.id,
    member.user.username,
    member.user.globalName,
    member.user.tag,
    member.displayName,
    member.nickname,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function channelName(channel: unknown): string {
  const name = objectProp(channel, 'name');
  const id = objectProp(channel, 'id');
  return typeof name === 'string' && name ? name : typeof id === 'string' ? id : 'unknown';
}

function channelPosition(channel: unknown): number {
  const position = objectProp(channel, 'position');
  return typeof position === 'number' ? position : 0;
}

function channelType(channel: unknown): number {
  const type = objectProp(channel, 'type');
  return typeof type === 'number' ? type : -1;
}

function canReadHistory(i: ChatInputCommandInteraction | StringSelectMenuInteraction, channel: unknown): boolean {
  if (!isMessageFetchChannel(channel)) return false;
  const botPerms = permissionsFor(channel, i.guild?.members.me ?? i.client.user);
  const actorPerms = permissionsFor(channel, i.user.id);
  return Boolean(
    botPerms?.has(PermissionsBitField.Flags.ViewChannel) &&
      botPerms.has(PermissionsBitField.Flags.ReadMessageHistory) &&
      actorPerms?.has(PermissionsBitField.Flags.ViewChannel) &&
      actorPerms.has(PermissionsBitField.Flags.ReadMessageHistory),
  );
}

function permissionsFor(channel: unknown, subject: unknown): PermissionsBitField | null {
  if (!channel || typeof channel !== 'object') return null;
  if (!subject) return null;
  const fn = (channel as { permissionsFor?: (target: unknown) => PermissionsBitField | null }).permissionsFor;
  if (typeof fn !== 'function') return null;
  try {
    return fn.call(channel, subject);
  } catch {
    return null;
  }
}

function objectProp(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}
