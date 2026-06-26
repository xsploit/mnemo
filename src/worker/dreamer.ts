import { getStore } from '../memory/store.js';
import { embedOne } from '../llm/embeddings.js';
import { consolidate } from '../cognition/consolidate.js';
import { reflect } from '../cognition/reflect.js';
import { dream } from '../cognition/dream.js';
import { forget } from '../cognition/forget.js';
import { logger } from '../logger.js';
import type { MemoryRecord } from '../memory/types.js';

const log = logger('dreamer');

export interface DreamReport {
  subjectId: string;
  observations: number;
  factsAdded: number;
  factsUpdated: number;
  factsDeleted: number;
  insights: number;
  diaryEntry: string | null;
  pruned: number;
}

/**
 * One full sleep cycle for a single subject. This is the separate "worker"
 * brain: it never talks to the user, it only rewrites the bot's memory.
 *
 *   1. INGEST     gather unprocessed episodic observations
 *   2. CONSOLIDATE distill durable semantic facts (ADD/UPDATE/DELETE)
 *   3. REFLECT    synthesize higher-level insights, citing their basis
 *   4. DREAM      write a first-person diary entry weaving it together
 *   5. FORGET     prune faded low-importance episodic memories
 */
export async function runSleepCycle(subjectId: string, opts: { lookbackHours?: number } = {}): Promise<DreamReport> {
  const store = await getStore();
  const lookbackHours = opts.lookbackHours ?? 48;
  const since = new Date(Date.now() - lookbackHours * 3_600_000);

  // 1. INGEST
  const observations = await store.recent(subjectId, ['episodic'], since, 60);
  log.info(`subject=${subjectId} ingesting ${observations.length} observations`);

  const report: DreamReport = {
    subjectId,
    observations: observations.length,
    factsAdded: 0,
    factsUpdated: 0,
    factsDeleted: 0,
    insights: 0,
    diaryEntry: null,
    pruned: 0,
  };

  if (observations.length === 0) return report;

  // 2. CONSOLIDATE — fetch the semantic facts most relevant to this batch first.
  const seed = await embedOne(observations.map((o) => o.content).join(' \n '));
  const existingFacts = await store.retrieve({
    subjectId,
    queryEmbedding: seed,
    kinds: ['semantic'],
    limit: 20,
    validOnly: true,
  });
  const consolidation = await consolidate(store, subjectId, observations, existingFacts);
  report.factsAdded = consolidation.added.length;
  report.factsUpdated = consolidation.updated;
  report.factsDeleted = consolidation.deleted;

  // 3. REFLECT — over observations + freshly minted facts.
  const reflectionInput: MemoryRecord[] = [...observations, ...consolidation.added];
  const reflection = await reflect(store, subjectId, reflectionInput);
  report.insights = reflection.created.length;

  // 4. DREAM — weave the highlights (most important facts + insights) into a diary.
  const highlights = [...consolidation.added, ...reflection.created]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 12);
  const diary = await dream(store, subjectId, highlights.length ? highlights : observations.slice(0, 8));
  report.diaryEntry = diary?.content ?? null;

  // 5. FORGET
  report.pruned = await forget(store, subjectId);

  log.info(
    `subject=${subjectId} cycle done: +${report.factsAdded} ~${report.factsUpdated} -${report.factsDeleted} facts, ` +
      `${report.insights} insights, ${report.pruned} pruned`,
  );
  return report;
}
