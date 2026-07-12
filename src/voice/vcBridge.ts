import type { Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../llm/media.js';
import { respond, respondVoiceStream } from '../bot/respond.js';
import { buildTaggedFishSpeechText } from './fishSpeechTags.js';
import { buildDiscordVoiceClip, fishTtsConfigured, synthesizeVoiceChunkFast } from './fishTts.js';
import { speakInVoice, speakMp3InVoice, type UtteranceHandler, type VcUtterance } from './vc.js';

const log = logger('vc-bridge');

/**
 * The full-duplex loop: VC utterance → transcription (same gateway media model
 * that reads voice-message attachments) → wake-word gate → the normal respond()
 * pipeline (memory, persona, inner voice, affinity — VC turns form memories like
 * text turns) → Fish TTS → played back into the voice channel. Turns are
 * serialized per guild so overlapping speakers don't trigger parallel replies.
 */
/** Rolling multi-speaker transcript per guild — everyone non-bot gets heard,
 *  and the recent room conversation rides along into her next reply. */
interface VcLine {
  name: string;
  text: string;
  at: number;
}
const roomTranscript = new Map<string, VcLine[]>();

/**
 * Attention sessions: the wake word is a doorbell, not a leash. Once woken
 * (by name or /vc join) she converses freely; the timer slides on every
 * engaged utterance and she goes idle after VC_ATTENTION_MIN of quiet.
 */
const attentiveUntil = new Map<string, number>();

export function markAttentive(guildId: string): void {
  attentiveUntil.set(guildId, Date.now() + config.vc.attentionMinutes * 60_000);
}

export function clearAttention(guildId: string): void {
  attentiveUntil.delete(guildId);
}

function isAttentive(guildId: string): boolean {
  return (attentiveUntil.get(guildId) ?? 0) > Date.now();
}

function wantsSleep(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return config.vc.sleepPhrases.some((p) => lower.includes(p));
}

function pushLine(guildId: string, name: string, text: string): void {
  const lines = roomTranscript.get(guildId) ?? [];
  lines.push({ name, text, at: Date.now() });
  const maxAge = config.vc.contextMaxAgeMin * 60_000;
  const fresh = lines.filter((l) => Date.now() - l.at < maxAge).slice(-config.vc.contextLines * 2);
  roomTranscript.set(guildId, fresh);
}

function renderRoom(guildId: string, excludeLast = 0): string {
  const lines = roomTranscript.get(guildId) ?? [];
  const usable = excludeLast > 0 ? lines.slice(0, -excludeLast) : lines;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return usable
    .slice(-config.vc.contextLines)
    .map((l) => `  <line speaker="${esc(l.name)}"${l.name === config.bot.name ? ' self="true" note="this is YOU"' : ''}>${esc(l.text)}</line>`)
    .join('\n');
}

export function createUtteranceHandler(client: Client): UtteranceHandler {
  const busy = new Set<string>();

  return (utterance: VcUtterance) => {
    void handle(client, utterance, busy).catch((e: any) => log.warn('vc turn failed', e?.message ?? e));
  };
}

async function handle(client: Client, u: VcUtterance, busy: Set<string>): Promise<void> {
  const transcript = (await transcribeAudio(u.wav, 'audio/wav', `vc-${u.userId}.wav`))?.trim();
  if (!transcript || isNonSpeech(transcript)) return;

  const guild = client.guilds.cache.get(u.guildId);
  const member = guild ? await guild.members.fetch(u.userId).catch(() => null) : null;
  const userName = member?.displayName ?? 'someone';

  const mirrorChannel =
    config.vc.textMirror && u.textChannelId
      ? await client.channels.fetch(u.textChannelId).catch(() => null)
      : null;
  const mirror = async (text: string) => {
    if (mirrorChannel && mirrorChannel.isTextBased() && 'send' in mirrorChannel) {
      await mirrorChannel.send(text).catch(() => {});
    }
  };

  await mirror(`🎙️ **${userName}:** ${transcript.slice(0, 1800)}`);
  pushLine(u.guildId, userName, transcript);

  // "Go to sleep" — instant dismissal back to idle (wake word to re-engage).
  if (isAttentive(u.guildId) && wantsSleep(transcript)) {
    clearAttention(u.guildId);
    await mirror(`😴 **${config.bot.name}** went idle — say "${config.vc.wakeWord}" to wake her.`);
    if (fishTtsConfigured()) {
      const bye = await synthesizeVoiceChunkFast("okay, going quiet. just say my name if you need me.");
      if (bye) speakMp3InVoice(u.guildId, bye);
    }
    return;
  }

  // Session gate: her name (or /vc join) wakes her; while awake she converses
  // freely — no wake word per line. Quiet for VC_ATTENTION_MIN → idle again.
  const woken = isAddressed(transcript);
  const engaged = config.vc.respondAll || woken || isAttentive(u.guildId);
  if (!engaged) return;
  markAttentive(u.guildId); // sliding window: active conversation keeps her awake

  // One turn at a time per guild — later utterances during her turn are heard
  // (mirrored above) but don't spawn parallel replies.
  if (busy.has(u.guildId)) return;
  busy.add(u.guildId);
  try {
    await runVoiceTurn(u, userName, transcript, mirror);
  } catch (e: any) {
    log.warn('vc turn failed', e?.message ?? e);
    const { aiProblemMessage } = await import('../bot/errorReply.js');
    await mirror(aiProblemMessage(e));
  } finally {
    busy.delete(u.guildId);
  }
}

async function runVoiceTurn(
  u: VcUtterance,
  userName: string,
  transcript: string,
  mirror: (text: string) => Promise<void>,
): Promise<void> {
  {
    if (config.vc.fastPipeline && fishTtsConfigured()) {
      // FAST PATH: stream tokens → flush each sentence to Fish ('balanced'
      // latency, mp3) → straight into the player. First audio lands after the
      // first sentence; later sentences synthesize while earlier ones play.
      // Synthesis is chained so sentences enter the queue in spoken order.
      let synthTail: Promise<void> = Promise.resolve();
      let firstAudioAt = 0;
      const started = Date.now();
      const result = await respondVoiceStream(
        {
          subjectId: u.userId,
          channelId: u.textChannelId ?? u.voiceChannelId,
          messageId: `vc-${u.guildId}-${Date.now()}`,
          userName,
          message: transcript,
          // Everyone's recent lines (excluding this one — it's the prompt itself),
          // so she tracks the whole room, not just whoever said her name.
          roomContext: renderRoom(u.guildId, 1) || undefined,
        },
        (sentence) => {
          synthTail = synthTail.then(async () => {
            const mp3 = await synthesizeVoiceChunkFast(sentence);
            if (mp3) {
              if (!firstAudioAt) {
                firstAudioAt = Date.now();
                log.info(`first audio queued ${firstAudioAt - started}ms after turn start`);
              }
              speakMp3InVoice(u.guildId, mp3);
            }
          });
        },
      );
      await synthTail;
      pushLine(u.guildId, config.bot.name, result.message); // her lines join the room context too
      await mirror(`💬 **${config.bot.name}:** ${result.message.slice(0, 1800)}`);
      return;
    }

    // SLOW PATH (VC_FAST=false): full respond() with tags + voice-message quality.
    const response = await respond({
      subjectId: u.userId,
      channelId: u.textChannelId ?? u.voiceChannelId,
      messageId: `vc-${u.guildId}-${Date.now()}`,
      userName,
      message: transcript,
      kind: 'mention',
    });

    await mirror(`💬 **${config.bot.name}:** ${response.message.slice(0, 1800)}`);

    if (fishTtsConfigured()) {
      const voiceText = await buildTaggedFishSpeechText({
        displayText: response.message,
        affect: response.affect,
        userName,
      });
      const clip = await buildDiscordVoiceClip(voiceText, 'hikari-vc');
      if (clip) {
        const queued = speakInVoice(u.guildId, clip.ogg);
        if (!queued) log.warn('reply ready but no active voice connection to speak into');
      }
    }
  }
}

// Whisper-family ASR models are well documented to hallucinate these exact
// stock phrases when fed silence, room tone, or non-speech noise — they were
// trained on YouTube-style captions and have to output *something*. This is
// the second line of defense after the local VAD gate in vc.ts (which should
// catch most of this before it ever reaches transcription).
const HALLUCINATION_PHRASES =
  /(thanks? (for watching|you)|please (subscribe|like)|like and subscribe|subscribe to my channel|don'?t forget to subscribe|see you (next time|in the next video)|amara\.org|transcribed by|captions? by|subtitles? by|www\.\S+\.(com|org)|\[?\(?(music|applause|laughter|silence|no speech|noise|static|beep|inaudible)\)?\]?)/i;

/** The media model describes non-speech audio, or the ASR hallucinated boilerplate over silence/noise. */
function isNonSpeech(transcript: string): boolean {
  const trimmed = transcript.trim();
  if (/^\(?\[?(silence|no speech|music|noise|static|beep|inaudible)/i.test(trimmed)) return true;
  if (HALLUCINATION_PHRASES.test(trimmed)) return true;
  if (isDegenerateRepetition(trimmed)) return true;
  return false;
}

/** Catches decode-loop artifacts like "the the the the the" — real speech doesn't do this. */
function isDegenerateRepetition(transcript: string): boolean {
  const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;
  const uniqueWords = new Set(words);
  return uniqueWords.size / words.length < 0.3; // <30% unique = repetition loop
}

/**
 * Robust wake detection. STT mangles names ("Hikaru", "Hey Kari", "hickory"),
 * so beyond substring + collapsed matching we fuzzy-match every word (and
 * adjacent word pair) against the wake word + aliases with edit distance ≤ 1.
 */
export function isAddressed(transcript: string): boolean {
  const targets = [config.vc.wakeWord, ...config.vc.wakeAliases].filter((t) => t.length >= 3);
  const lower = transcript.toLowerCase();
  const collapse = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const collapsed = collapse(transcript);

  for (const t of targets) {
    if (lower.includes(t) || collapsed.includes(collapse(t))) return true;
  }

  const words = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const candidates = [...words];
  for (let i = 0; i < words.length - 1; i++) candidates.push(words[i]! + words[i + 1]!);

  for (const t of targets) {
    const ct = collapse(t);
    if (ct.length < 4) continue;
    for (const w of candidates) {
      if (Math.abs(w.length - ct.length) <= 1 && editDistanceAtMostOne(w, ct)) return true;
    }
  }
  return false;
}

/** Cheap check: is edit distance(a,b) ≤ 1? (insert/delete/substitute one char) */
function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (s.length === l.length) {
      i++;
      j++;
    } else {
      j++; // skip one char in the longer string
    }
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}
