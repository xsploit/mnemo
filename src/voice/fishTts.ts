import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Session, TTSRequest } from 'fish-audio-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('tts:fish');

// The Fish SDK unconditionally console.log's "TTS Request:"/"TTS Headers:" on
// every synthesis (echoing the spoken text). Quietly drop just those two lines.
const originalConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && (first.startsWith('TTS Request:') || first.startsWith('TTS Headers:'))) return;
  originalConsoleLog(...args);
};

export interface VoiceClip {
  buffer: Buffer;
  ext: string;
  contentType: string;
  inputChars: number;
  truncated: boolean;
}

export interface DiscordVoiceClip {
  ogg: Buffer;
  durationSecs: number;
  waveform: string;
  inputChars: number;
  truncated: boolean;
  elapsedMs: number;
}

const AUDIO_FORMATS = ['wav', 'pcm', 'mp3', 'opus'] as const;
type AudioFormat = (typeof AUDIO_FORMATS)[number];
const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;
const SAMPLE_RATE = 48_000;

/** True when a Fish Audio key + voice are configured. */
export function fishTtsConfigured(): boolean {
  return Boolean(config.fish.apiKey && config.fish.voiceId);
}

let session: Session | null = null;
function getSession(): Session {
  if (!session) session = new Session(config.fish.apiKey, config.fish.baseUrl);
  return session;
}

function audioFormat(): AudioFormat {
  return (AUDIO_FORMATS as readonly string[]).includes(config.fish.format)
    ? (config.fish.format as AudioFormat)
    : 'mp3';
}

/**
 * Synthesize speech for `text` in the configured Fish Audio voice using the
 * official SDK. Returns null (never throws) when TTS is unconfigured or the
 * request fails, so a voice hiccup never blocks the text reply. The `model`
 * header selects the backbone (e.g. s1).
 */
export async function synthesizeVoice(text: string): Promise<VoiceClip | null> {
  if (!fishTtsConfigured()) return null;
  const { clean, inputChars, truncated } = cleanForSpeech(text);
  if (!clean) return null;

  const format = audioFormat();
  const request = new TTSRequest(clean, {
    referenceId: config.fish.voiceId,
    format,
    normalize: true,
    latency: 'normal',
  });

  // Only send the model header when one is configured; empty = account default.
  const headers = config.fish.model ? { model: config.fish.model } : undefined;
  try {
    const collect = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of getSession().tts(request, headers)) chunks.push(chunk);
      return Buffer.concat(chunks);
    })();
    const buffer = await Promise.race([collect, timeoutReject(config.fish.timeoutMs)]);
    if (buffer.length === 0) return null;
    return { buffer, ext: format, contentType: contentTypeFor(format), inputChars, truncated };
  } catch (e: any) {
    log.warn('tts request failed', e?.message ?? e);
    return null;
  }
}

export async function buildDiscordVoiceClip(text: string, namePrefix = 'hikari'): Promise<DiscordVoiceClip | null> {
  const started = Date.now();
  const clip = await synthesizeVoice(text);
  if (!clip) return null;

  await fs.mkdir(config.fish.outputRoot, { recursive: true });
  const tempBase = path.join(config.fish.outputRoot, `${namePrefix}-${Date.now()}-${crypto.randomUUID()}`);
  const inputPath = `${tempBase}.${clip.ext}`;
  try {
    await fs.writeFile(inputPath, clip.buffer);
    const pcm = limitPcmS16lePeak(await decodeAudioToPcmS16le(inputPath), config.fish.voiceTargetPeak);
    const ogg = await encodePcmS16leToOggOpus(pcm);
    return {
      ogg,
      durationSecs: Number(pcmDurationSecs(pcm).toFixed(3)),
      waveform: waveformBase64FromPcmS16le(pcm),
      inputChars: clip.inputChars,
      truncated: clip.truncated,
      elapsedMs: Date.now() - started,
    };
  } catch (e: any) {
    log.warn('voice clip conversion failed', e?.message ?? e);
    return null;
  } finally {
    await fs.unlink(inputPath).catch(() => {});
  }
}

export async function sendDiscordVoiceMessage(
  channelId: string,
  clip: DiscordVoiceClip,
  filename = 'voice-message.ogg',
): Promise<string | null> {
  const api = 'https://discord.com/api/v10';
  const headers = {
    Authorization: `Bot ${config.discord.token}`,
    'Content-Type': 'application/json',
  };

  const attachmentResponse = await fetchWithTimeout(`${api}/channels/${channelId}/attachments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      files: [{ id: '0', filename, file_size: clip.ogg.byteLength }],
    }),
  });
  if (!attachmentResponse.ok) throw new Error(`attachment create failed: ${attachmentResponse.status} ${await attachmentResponse.text()}`);
  const attachmentJson = (await attachmentResponse.json()) as {
    attachments?: Array<{ id?: string; upload_url?: string; upload_filename?: string }>;
  };
  const upload = attachmentJson.attachments?.[0];
  if (!upload?.upload_url || !upload.upload_filename) throw new Error('Discord did not return a voice upload URL.');

  const uploadResponse = await fetchWithTimeout(upload.upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'audio/ogg',
      'Content-Length': String(clip.ogg.byteLength),
    },
    body: clip.ogg,
  });
  if (!uploadResponse.ok) throw new Error(`voice upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);

  const messageResponse = await fetchWithTimeout(`${api}/channels/${channelId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      flags: DISCORD_VOICE_MESSAGE_FLAG,
      attachments: [
        {
          id: upload.id ?? '0',
          filename,
          uploaded_filename: upload.upload_filename,
          duration_secs: clip.durationSecs,
          waveform: clip.waveform,
        },
      ],
    }),
  });
  if (!messageResponse.ok) throw new Error(`voice message send failed: ${messageResponse.status} ${await messageResponse.text()}`);
  const sent = (await messageResponse.json()) as { id?: string };
  return sent.id ?? null;
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`tts timeout after ${ms}ms`)), ms));
}

/** Strip things that sound bad when read aloud, and cap length (Fish bills per byte). */
function cleanForSpeech(text: string): { clean: string; inputChars: number; truncated: boolean } {
  let t = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const inputChars = t.length;
  const truncated = t.length > config.fish.maxChars;
  if (truncated) t = `${t.slice(0, config.fish.maxChars).trimEnd()}...`;
  return { clean: t, inputChars, truncated };
}

function contentTypeFor(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/opus';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}

async function decodeAudioToPcmS16le(inputPath: string): Promise<Buffer> {
  return spawnBuffered(config.fish.ffmpegBin, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ]);
}

async function encodePcmS16leToOggOpus(pcm: Buffer): Promise<Buffer> {
  return spawnBuffered(
    config.fish.ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      config.fish.voiceOpusBitrate,
      '-vbr',
      'on',
      '-f',
      'ogg',
      'pipe:1',
    ],
    pcm,
  );
}

function limitPcmS16lePeak(pcm: Buffer, targetPeak: number): Buffer {
  if (pcm.length < 2) return pcm;
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  const target = Math.max(0.05, Math.min(1, targetPeak)) * 32767;
  if (peak <= target || peak === 0) return pcm;
  const gain = target / peak;
  const out = Buffer.allocUnsafe(pcm.length);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(offset) * gain))), offset);
  }
  return out;
}

function pcmDurationSecs(pcm: Buffer): number {
  return pcm.length / 2 / SAMPLE_RATE;
}

function waveformBase64FromPcmS16le(pcm: Buffer, samples = 100): string {
  if (pcm.length < 2) return Buffer.alloc(0).toString('base64');
  const frameCount = Math.floor(pcm.length / 2);
  const bucketSize = Math.max(1, Math.floor(frameCount / samples));
  const bytes: number[] = [];
  for (let bucket = 0; bucket * bucketSize < frameCount && bytes.length < samples; bucket++) {
    let peak = 0;
    const start = bucket * bucketSize;
    const end = Math.min(frameCount, start + bucketSize);
    for (let frame = start; frame < end; frame++) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(frame * 2)));
    }
    bytes.push(Math.max(0, Math.min(255, Math.round((peak / 32767) * 255))));
  }
  return Buffer.from(bytes).toString('base64');
}

function spawnBuffered(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timeout after ${config.fish.timeoutMs}ms`));
    }, config.fish.timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fish.voiceUploadTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
