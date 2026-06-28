import { embed, embedMany } from 'ai';
import { models } from './gateway.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { localEmbedOne, localEmbedAll } from './localEmbed.js';

const log = logger('embed');

export async function embedOne(text: string): Promise<number[]> {
  if (config.embed.provider === 'local') return localEmbedOne(text);
  try {
    const { embedding } = await embed({ model: models.embed, value: text });
    return embedding;
  } catch (e: any) {
    if (!config.embed.localBackup) throw e;
    log.warn('Vercel embedding failed — using local backup', e?.message ?? e);
    return localEmbedOne(text);
  }
}

export async function embedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (config.embed.provider === 'local') return localEmbedAll(texts);
  try {
    const { embeddings } = await embedMany({ model: models.embed, values: texts });
    return embeddings;
  } catch (e: any) {
    if (!config.embed.localBackup) throw e;
    log.warn('Vercel batch embedding failed — using local backup', e?.message ?? e);
    return localEmbedAll(texts);
  }
}

export function cosine(a: number[], b: number[]): number {
  // Vectors from different embedding spaces (e.g. Vercel 1536-dim vs local 384-dim)
  // aren't comparable — treat as no match rather than scoring garbage on a prefix.
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
