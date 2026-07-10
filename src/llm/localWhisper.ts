import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('whisper:local');

/**
 * Local Whisper fallback for transcription (voice-message attachments + VC),
 * via transformers.js ONNX — the same runtime that already serves local
 * embeddings, so this adds zero dependencies. Weights download once on first
 * use (~74MB for whisper-base) and run fully offline afterwards. Lazy-loaded:
 * costs nothing unless the gateway transcription path actually fails.
 */
type AsrPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;

let asr: AsrPipeline | null = null;
let loading: Promise<AsrPipeline> | null = null;

async function getAsr(): Promise<AsrPipeline> {
  if (asr) return asr;
  if (!loading) {
    loading = (async () => {
      log.info(`loading local whisper model ${config.media.localWhisperModel} (first run downloads weights)`);
      const { pipeline } = await import('@huggingface/transformers');
      asr = (await pipeline('automatic-speech-recognition', config.media.localWhisperModel)) as unknown as AsrPipeline;
      log.info('local whisper ready');
      return asr;
    })();
  }
  return loading;
}

/** Transcribe any audio container (wav/ogg/mp3/…) locally. Returns null on failure. */
export async function localWhisperTranscribe(bytes: Uint8Array): Promise<string | null> {
  try {
    const pcm = await toWhisperPcm(bytes);
    if (pcm.length < 1600) return null; // <0.1s of audio — nothing to hear
    const model = await getAsr();
    const out = await model(pcm, { chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : (out.text ?? '')).trim();
    return text || null;
  } catch (e: any) {
    log.warn('local whisper failed', e?.message ?? e);
    return null;
  }
}

/** Whisper wants 16kHz mono float32 — ffmpeg converts from whatever we were handed. */
function toWhisperPcm(bytes: Uint8Array): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.fish.ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg timeout during whisper resample'));
    }, 30_000);
    child.stdout.on('data', (c) => stdout.push(Buffer.from(c)));
    child.stderr.on('data', (c) => stderr.push(Buffer.from(c)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
        return;
      }
      const buf = Buffer.concat(stdout);
      const f32 = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < f32.length; i++) f32[i] = buf.readFloatLE(i * 4);
      resolve(f32);
    });
    child.stdin.end(Buffer.from(bytes));
  });
}
