import { logger } from '../logger.js';
import type { MemoryStore } from '../memory/types.js';

const log = logger('forget');

/**
 * Forgetting is a feature, not a bug. After the higher-value semantic facts and
 * insights have been distilled out, the raw low-importance episodic chatter has
 * served its purpose. We prune episodic memories that are old, rarely accessed,
 * and low importance, plus anything whose validity window has closed and aged.
 *
 * `RECENCY_HALFLIFE_HOURS` already decays these in ranking; this is the hard
 * sweep that keeps the store small enough to live on a single machine.
 */
export async function forget(
  store: MemoryStore,
  subjectId: string,
  opts: { olderThanHours?: number; importanceBelow?: number } = {},
): Promise<number> {
  const olderThanHours = opts.olderThanHours ?? 72;
  const importanceBelow = opts.importanceBelow ?? 4;
  const before = new Date(Date.now() - olderThanHours * 3_600_000);

  const n = await store.prune(subjectId, before, importanceBelow);
  if (n) log.info(`subject=${subjectId} pruned ${n} faded memories`);
  return n;
}
