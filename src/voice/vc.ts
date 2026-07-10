import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import type { VoiceBasedChannel } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('vc');

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;

/** One finished spoken utterance from a VC member, decoded to WAV. */
export interface VcUtterance {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string | null;
  userId: string;
  wav: Buffer;
  durationMs: number;
}

export type UtteranceHandler = (utterance: VcUtterance) => void;

/**
 * Live voice-channel presence (speak-side). One connection per guild; replies
 * are queued so overlapping turns play back-to-back instead of cutting each
 * other off. Input is the same ogg/opus Buffer the Fish TTS pipeline already
 * produces for voice messages, so VC playback needs no extra transcoding.
 * DAVE E2EE is handled automatically by @discordjs/voice via @snazzah/davey.
 * Listening (voice receive) is intentionally out of scope — under DAVE it is
 * still unstable in discord.js; the Python dvb bot covers that use case.
 */
interface QueuedClip {
  buffer: Buffer;
  type: StreamType;
}

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
  textChannelId: string | null;
  queue: QueuedClip[];
  playing: boolean;
  listening: boolean;
  /** Users whose current utterance is mid-capture (one stream per speaker). */
  capturing: Set<string>;
}

const guilds = new Map<string, GuildVoice>();

export interface JoinVoiceOptions {
  /** Capture + transcribe what members say (full-duplex). Default true. */
  listen?: boolean;
  /** Text channel to mirror the conversation into (usually where /vc ran). */
  textChannelId?: string | null;
  /** Called once per finished utterance with decoded WAV audio. */
  onUtterance?: UtteranceHandler;
}

export async function joinVoice(channel: VoiceBasedChannel, opts: JoinVoiceOptions = {}): Promise<void> {
  const listen = opts.listen ?? true;
  const existing = guilds.get(channel.guild.id);
  if (existing && existing.channelId === channel.id && existing.listening === listen) return;
  if (existing) leaveVoice(channel.guild.id);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: !listen,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (e) {
    connection.destroy();
    throw new Error(`could not become Ready in ${channel.name}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  const state: GuildVoice = {
    connection,
    player,
    channelId: channel.id,
    textChannelId: opts.textChannelId ?? null,
    queue: [],
    playing: false,
    listening: listen,
    capturing: new Set(),
  };
  guilds.set(channel.guild.id, state);

  if (listen && opts.onUtterance) wireReceiver(state, channel, opts.onUtterance);

  player.on(AudioPlayerStatus.Idle, () => {
    state.playing = false;
    void playNext(state);
  });
  player.on('error', (e) => {
    log.warn('player error', e?.message ?? e);
    state.playing = false;
    void playNext(state);
  });
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    // Kicked / moved / channel deleted — clean up rather than zombie-reconnect.
    log.info(`disconnected from voice in guild ${channel.guild.id}`);
    leaveVoice(channel.guild.id);
  });

  log.info(`joined voice channel #${channel.name} (${channel.id})`);
}

export function leaveVoice(guildId: string): boolean {
  const state = guilds.get(guildId);
  if (!state) return false;
  guilds.delete(guildId);
  try {
    state.player.stop(true);
    state.connection.destroy();
  } catch {
    // already torn down
  }
  return true;
}

/** The voice channel id she's connected to in this guild, if any. */
export function activeVoiceChannel(guildId: string | null | undefined): string | null {
  if (!guildId) return null;
  return guilds.get(guildId)?.channelId ?? null;
}

/** Queue an ogg/opus clip (the Fish pipeline's native output) for VC playback. */
export function speakInVoice(guildId: string, ogg: Buffer): boolean {
  return enqueueClip(guildId, { buffer: ogg, type: StreamType.OggOpus });
}

/**
 * Queue a raw mp3 chunk (fast streaming path) — the player pipes it through its
 * own ffmpeg, so per-sentence chunks go straight from Fish to the speaker.
 */
export function speakMp3InVoice(guildId: string, mp3: Buffer): boolean {
  return enqueueClip(guildId, { buffer: mp3, type: StreamType.Arbitrary });
}

function enqueueClip(guildId: string, clip: QueuedClip): boolean {
  const state = guilds.get(guildId);
  if (!state) return false;
  state.queue.push(clip);
  void playNext(state);
  return true;
}

async function playNext(state: GuildVoice): Promise<void> {
  if (state.playing) return;
  const next = state.queue.shift();
  if (!next) return;
  state.playing = true;
  try {
    const resource = createAudioResource(Readable.from(next.buffer), { inputType: next.type });
    state.player.play(resource);
  } catch (e: any) {
    log.warn('failed to start playback', e?.message ?? e);
    state.playing = false;
    void playNext(state);
  }
}

/**
 * Listen side: one capture per speaking member. The receiver hands us the
 * (DAVE-decrypted) opus stream; we decode to PCM, wait for trailing silence to
 * close the utterance, wrap it in a WAV header, and hand it to the bridge for
 * transcription. Blips shorter than the floor are dropped as noise.
 */
function wireReceiver(state: GuildVoice, channel: VoiceBasedChannel, onUtterance: UtteranceHandler): void {
  const receiver = state.connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (state.capturing.has(userId)) return;
    const member = channel.guild.members.cache.get(userId);
    if (member?.user.bot) return; // never transcribe bots (incl. ourselves)
    state.capturing.add(userId);

    const started = Date.now();
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.vc.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const pcmChunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = (config.vc.maxUtteranceMs / 1000) * SAMPLE_RATE * CHANNELS * 2;

    decoder.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxBytes) pcmChunks.push(chunk);
      else opusStream.destroy(); // cap runaway monologues
    });

    const finish = () => {
      state.capturing.delete(userId);
      const pcm = Buffer.concat(pcmChunks);
      const durationMs = Math.round((pcm.length / 2 / CHANNELS / SAMPLE_RATE) * 1000);
      if (durationMs < config.vc.minUtteranceMs) return; // cough/keyclick noise
      onUtterance({
        guildId: channel.guild.id,
        voiceChannelId: channel.id,
        textChannelId: state.textChannelId,
        userId,
        wav: pcmToWav(pcm),
        durationMs,
      });
      log.debug(`captured ${durationMs}ms utterance from ${userId} (started ${started})`);
    };

    opusStream.pipe(decoder);
    decoder.once('end', finish);
    decoder.once('error', (e) => {
      state.capturing.delete(userId);
      log.warn(`opus decode error for ${userId}`, e?.message ?? e);
    });
    opusStream.once('error', (e) => {
      state.capturing.delete(userId);
      log.warn(`receive stream error for ${userId}`, e?.message ?? e);
    });
  });
}

/** Wrap raw PCM s16le 48kHz stereo in a WAV header for the transcription model. */
function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
