import { embed, embedMany } from 'ai';
import { models } from './gateway.js';

export async function embedOne(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: models.embed, value: text });
  return embedding;
}

export async function embedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({ model: models.embed, values: texts });
  return embeddings;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
