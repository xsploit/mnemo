import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger('embed:local');

// Lazy singleton — the model (and its ~20MB weights) only load the first time the
// local backup is actually needed, so normal Vercel-path runs pay nothing.
type Extractor = (input: string | string[], opts: Record<string, unknown>) => Promise<any>;
let extractor: Extractor | null = null;
let loading: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (extractor) return extractor;
  if (!loading) {
    loading = (async () => {
      log.info(`loading local embedding model ${config.embed.localModel} (first run downloads weights)`);
      const { pipeline } = await import('@huggingface/transformers');
      extractor = (await pipeline('feature-extraction', config.embed.localModel)) as unknown as Extractor;
      log.info('local embedding model ready');
      return extractor;
    })();
  }
  return loading;
}

export async function localEmbedOne(text: string): Promise<number[]> {
  const ex = await getExtractor();
  const out = await ex(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data as Float32Array);
}

export async function localEmbedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ex = await getExtractor();
  const out = await ex(texts, { pooling: 'mean', normalize: true });
  const list = typeof out.tolist === 'function' ? (out.tolist() as number[][]) : [Array.from(out.data as Float32Array)];
  return list;
}
