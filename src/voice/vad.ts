import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('vad');

/**
 * Real Silero VAD (v5, ONNX) — not a heuristic. The exact tensor contract below
 * (input [1,512] float32, state [2,1,128] float32 recurrent, sr int64, output
 * "output"/"stateN") is taken from the actively-maintained ricky0123/vad-web
 * reference implementation (packages/web/src/models/v5.ts), not guessed.
 *
 * Discord's own "speaking" signal just means SOME mic input was flagged active
 * on the far end — it is not speech detection. Feeding a Whisper-family ASR
 * silence/room-tone/noise is exactly what makes it hallucinate stock phrases,
 * because the model has to output *something*. This gate runs a real trained
 * speech-vs-non-speech classifier on the decoded PCM before transcription ever
 * sees it.
 *
 * Model weights: onnx-community/silero-vad (MIT), the same HF-hub distribution
 * channel already used for local Whisper/embeddings in this codebase — cached
 * locally after the first download, runs fully offline after that.
 */
const MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';
const MODEL_PATH = path.resolve('data', 'models', 'silero-vad.onnx');
const FRAME_SAMPLES = 512; // Silero's fixed chunk size at 16kHz (32ms)
const VAD_SAMPLE_RATE = 16_000;

export interface VadResult {
  speech: boolean;
  /** Mean speech probability across all frames in the utterance. */
  avgProb: number;
  /** Highest single-frame speech probability. */
  maxProb: number;
  /** Fraction of frames whose probability cleared the threshold. */
  activeRatio: number;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function ensureModelDownloaded(): Promise<void> {
  try {
    await fs.access(MODEL_PATH);
    return;
  } catch {
    // not cached yet
  }
  log.info(`downloading Silero VAD model (first run only) from ${MODEL_URL}`);
  await fs.mkdir(path.dirname(MODEL_PATH), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Silero VAD model download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tmp = `${MODEL_PATH}.tmp`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, MODEL_PATH);
  log.info(`Silero VAD model cached (${bytes.byteLength} bytes)`);
}

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await ensureModelDownloaded();
      const session = await ort.InferenceSession.create(MODEL_PATH);
      log.info('Silero VAD session ready');
      return session;
    })();
  }
  return sessionPromise;
}

function newState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

/**
 * Run the real Silero VAD model over already-decoded PCM. `sampleRate`/
 * `channels` describe the INPUT pcm (e.g. 48kHz stereo from Discord's opus
 * decoder) — this resamples to the 16kHz mono the model requires.
 */
export async function detectSpeech(pcm: Buffer, sampleRate: number, channels: number): Promise<VadResult> {
  const session = await getSession();
  const mono16k = await resampleToMono16k(pcm, sampleRate, channels);

  const frameCount = Math.floor(mono16k.length / FRAME_SAMPLES);
  if (frameCount === 0) return { speech: false, avgProb: 0, maxProb: 0, activeRatio: 0 };

  let state = newState();
  const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]));
  const probs: number[] = [];

  for (let f = 0; f < frameCount; f++) {
    const frame = mono16k.subarray(f * FRAME_SAMPLES, (f + 1) * FRAME_SAMPLES);
    const inputTensor = new ort.Tensor('float32', frame, [1, FRAME_SAMPLES]);
    const out = await session.run({ input: inputTensor, state, sr: srTensor });
    const stateN = out['stateN'];
    const output = out['output'];
    if (!stateN || !output?.data?.length) throw new Error('Silero VAD model returned unexpected output shape');
    state = stateN;
    probs.push(output.data[0] as number);
  }

  const threshold = config.vc.vadProbThreshold;
  const activeFrames = probs.filter((p) => p >= threshold).length;
  const activeRatio = activeFrames / probs.length;
  const avgProb = probs.reduce((sum, p) => sum + p, 0) / probs.length;
  const maxProb = Math.max(...probs);
  const speech = activeRatio >= config.vc.vadMinActiveRatio;

  return { speech, avgProb, maxProb, activeRatio };
}

/** s16le PCM at (sampleRate, channels) -> float32 mono @16kHz, via ffmpeg. */
function resampleToMono16k(pcm: Buffer, sampleRate: number, channels: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.fish.ffmpegBin,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
        '-f', 'f32le', '-ar', String(VAD_SAMPLE_RATE), '-ac', '1', 'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg VAD resample timeout'));
    }, 15_000);
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
      const floats = new Float32Array(buf.length / 4);
      for (let i = 0; i < floats.length; i++) floats[i] = buf.readFloatLE(i * 4);
      resolve(floats);
    });
    child.stdin.end(pcm);
  });
}
