import { config } from '../config.js';
import { cosine } from '../llm/embeddings.js';
import type { MemoryRecord, ScoredMemory } from './types.js';

/**
 * Generative-Agents retrieval score:
 *
 *   score = w_rel·relevance + w_imp·importance + w_rec·recency
 *
 * - relevance: cosine similarity to the query, normalized to [0,1]
 * - importance: the 1–10 score assigned at write time, normalized to [0,1]
 * - recency:    exponential decay since the memory was last accessed
 *
 * (Park et al., "Generative Agents: Interactive Simulacra of Human Behavior".)
 */
export function scoreMemory(
  m: MemoryRecord,
  queryEmbedding: number[],
  now: Date,
): ScoredMemory {
  const relevance = m.embedding ? (cosine(queryEmbedding, m.embedding) + 1) / 2 : 0;
  const importance = Math.min(Math.max(m.importance, 0), 10) / 10;

  const hoursSince = (now.getTime() - m.lastAccessedAt.getTime()) / 3_600_000;
  const halfLife = config.retrieval.recencyHalflifeHours;
  const recency = Math.pow(0.5, hoursSince / halfLife);

  const { wRelevance, wImportance, wRecency } = config.retrieval;
  const score = wRelevance * relevance + wImportance * importance + wRecency * recency;

  return { ...m, score, parts: { relevance, importance, recency } };
}

export function rankMemories(
  candidates: MemoryRecord[],
  queryEmbedding: number[],
  now: Date,
  limit: number,
): ScoredMemory[] {
  return candidates
    .map((m) => scoreMemory(m, queryEmbedding, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
