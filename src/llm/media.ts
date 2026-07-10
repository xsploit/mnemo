import { generateText } from 'ai';
import { gateway, gatewayProviderOptions } from './gateway.js';
import { localWhisperTranscribe } from './localWhisper.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('media');

/**
 * Multimodal perception: image description and voice-message transcription,
 * both through one gemini model on the Vercel gateway (gemini takes image AND
 * audio parts natively, so no separate Whisper pipeline is needed). Discord CDN
 * URLs are signed and expire, and Google's own URL fetcher rejects them anyway —
 * so callers download the bytes and pass them in. Best-effort: any failure
 * returns null and the attachment falls back to metadata-only context.
 */
export function mediaPerceptionEnabled(): boolean {
  return config.media.enabled;
}

export async function describeImage(bytes: Uint8Array, name: string, contextText?: string): Promise<string | null> {
  if (!config.media.enabled) return null;
  try {
    const res = await generateText({
      model: gateway(config.media.model),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Write a detailed, accurate visual description (alt text) of this image (filename: ${name}) for a reader who cannot see it.`,
                contextText?.trim()
                  ? `It was shared in a chat alongside this message — prioritize what is relevant to it: "${contextText.trim().slice(0, 300)}"`
                  : '',
                'Adapt the description to the content:',
                '- Photo or artwork: what/who is shown, the mood, anything notable or funny.',
                '- Meme: the format, the caption text verbatim, and the joke.',
                '- Screenshot (app, game, chat, terminal, stream, code, error): name the app or site if recognizable, describe the layout briefly, then transcribe the important visible text verbatim — titles, chat messages with their usernames, error messages, code, numbers, stats, labels. The text is the content; do not summarize it away.',
                'Length should match the density: a dense screenshot deserves a thorough read; a simple photo needs one or two sentences. Plain description only, no preamble.',
              ]
                .filter(Boolean)
                .join('\n'),
            },
            { type: 'image', image: bytes },
          ],
        },
      ],
      temperature: 0.2,
      // Room for a thorough screenshot read; thinking disabled — describing an
      // image is perception, not a puzzle, and gemini's reasoning tokens were
      // eating the whole budget before any visible output.
      maxOutputTokens: 4000,
      providerOptions: { ...gatewayProviderOptions, google: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    const text = res.text.trim();
    return text || null;
  } catch (e: any) {
    log.warn(`image description failed (${name})`, e?.message ?? e);
    return null;
  }
}

export async function transcribeAudio(bytes: Uint8Array, mediaType: string, name: string): Promise<string | null> {
  if (!config.media.enabled) return null;
  try {
    const res = await generateText({
      model: gateway(config.media.model),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `This is an audio attachment (filename: ${name}) from a Discord chat, likely a voice message. ` +
                'Transcribe any speech verbatim. If there is no speech, describe the sound in one short sentence. ' +
                'Output only the transcript or description, no preamble.',
            },
            { type: 'file', data: bytes, mediaType: normalizeAudioType(mediaType) },
          ],
        },
      ],
      temperature: 0,
      maxOutputTokens: 2000,
      providerOptions: gatewayProviderOptions,
    });
    const text = res.text.trim();
    if (text) return text;
    throw new Error('gateway returned empty transcript');
  } catch (e: any) {
    log.warn(`gateway transcription failed (${name})`, e?.message ?? e);
    if (!config.media.localWhisperBackup) return null;
    // Belt-and-suspenders: local Whisper (transformers.js) — covers gateway
    // outages, rate limits, and empty credits for voice clips AND voice chat.
    const local = await localWhisperTranscribe(bytes);
    if (local) log.info(`local whisper transcribed ${name} after gateway failure`);
    return local;
  }
}

/** Discord voice messages are `audio/ogg; codecs=opus` — strip params, map gaps. */
function normalizeAudioType(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('audio/')) return base;
  return 'audio/ogg';
}

/** Shared bounded download for media attachments (signed Discord CDN URLs). */
export async function downloadMedia(url: string, maxBytes: number): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      log.warn(`media download failed: HTTP ${response.status}`);
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    if (bytes.byteLength > maxBytes) {
      log.warn(`media skipped: ${bytes.byteLength} bytes exceeds cap ${maxBytes}`);
      return null;
    }
    return bytes;
  } catch (e: any) {
    log.warn('media download errored', e?.message ?? e);
    return null;
  }
}

/**
 * Shrink big images before the model call: raw 4K screenshots run 8-20MB, which
 * blows caps and wastes tokens. ffmpeg re-encodes anything over ~1.5MB to a
 * ≤1536px JPEG (first frame for GIFs). Returns the original on any failure.
 */
export async function normalizeImageForModel(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.byteLength <= 1_500_000) return bytes;
  try {
    const { spawn } = await import('node:child_process');
    const out = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        config.fish.ffmpegBin,
        ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', "scale='min(1536,iw)':-2", '-q:v', '4', '-f', 'mjpeg', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('ffmpeg image resize timeout'));
      }, 20_000);
      child.stdout.on('data', (c) => stdout.push(Buffer.from(c)));
      child.stderr.on('data', (c) => stderr.push(Buffer.from(c)));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.length) resolve(Buffer.concat(stdout));
        else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 200)}`));
      });
      child.stdin.end(Buffer.from(bytes));
    });
    log.info(`image downscaled ${bytes.byteLength} → ${out.byteLength} bytes for vision`);
    return new Uint8Array(out);
  } catch (e: any) {
    log.warn('image downscale failed; sending original', e?.message ?? e);
    return bytes;
  }
}
