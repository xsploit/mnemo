import crypto from 'node:crypto';
import { getStore } from '../memory/store.js';
import { embedOne } from '../llm/embeddings.js';
import { consolidate } from '../cognition/consolidate.js';
import { reflect } from '../cognition/reflect.js';
import { dream } from '../cognition/dream.js';
import { forget } from '../cognition/forget.js';
import { evolveSelf } from '../cognition/selfReflect.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { MemoryRecord } from '../memory/types.js';
import { rehearseFuture } from '../development/rehearse.js';
import { diagnosePolicyCandidate, evaluateDiagnosedPolicyCandidate } from '../development/policyLab.js';
import { activityVersion } from './activity.js';

const log = logger('dreamer');

export interface DreamReport {
  subjectId: string;
  observations: number;
  factsAdded: number;
  factsUpdated: number;
  factsDeleted: number;
  insights: number;
  diaryEntry: string | null;
  simulations: number;
  simulationPreview: string | null;
  policyCandidate: string | null;
  policyDecision: string | null;
  pruned: number;
  /** What changed in her own evolving self this cycle (baseline drift, self-notes). */
  selfEvolution: string[];
  /** Activity generation captured by the cycle itself before ingest. */
  throughActivityVersion: number;
}

const activeBySubject = new Map<string, Promise<DreamReport>>();

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
export function runSleepCycle(subjectId: string, opts: { lookbackHours?: number } = {}): Promise<DreamReport> {
  const active = activeBySubject.get(subjectId);
  if (active) return active;
  const cycle = runSleepCycleInternal(subjectId, opts);
  activeBySubject.set(subjectId, cycle);
  void cycle
    .finally(() => {
      if (activeBySubject.get(subjectId) === cycle) activeBySubject.delete(subjectId);
    })
    .catch(() => {});
  return cycle;
}

async function runSleepCycleInternal(subjectId: string, opts: { lookbackHours?: number }): Promise<DreamReport> {
  const cycleId = crypto.randomUUID();
  const store = await getStore();
  const lookbackHours = opts.lookbackHours ?? 48;
  const since = new Date(Date.now() - lookbackHours * 3_600_000);

  // 1. INGEST
  const throughActivityVersion = activityVersion(subjectId);
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
    simulations: 0,
    simulationPreview: null,
    policyCandidate: null,
    policyDecision: null,
    pruned: 0,
    selfEvolution: [],
    throughActivityVersion,
  };

  if (observations.length === 0) return report;

  // 2. CONSOLIDATE — fetch the semantic facts most relevant to this batch first.
  let existingFacts: MemoryRecord[] = [];
  try {
    const seed = await embedOne(observations.map((o) => o.content).join(' \n '));
    existingFacts = await store.retrieve({
      subjectId,
      queryEmbedding: seed,
      kinds: ['semantic'],
      limit: 20,
      validOnly: true,
    });
  } catch (e: any) {
    log.warn(`subject=${subjectId} existing-fact retrieval skipped`, e?.message);
  }
  const consolidation = await consolidate(store, subjectId, observations, existingFacts);
  report.factsAdded = consolidation.added.length;
  report.factsUpdated = consolidation.updated;
  report.factsDeleted = consolidation.deleted;

  // 3. REFLECT — over observations + freshly minted facts.
  const reflectionInput: MemoryRecord[] = [...observations, ...consolidation.added];
  const reflection = await reflect(store, subjectId, reflectionInput);
  report.insights = reflection.created.length;

  // 4. REHEARSE — imagine plausible future conversations in a separate,
  // explicitly non-factual simulation namespace.
  const highlights = [...consolidation.added, ...reflection.created]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 12);
  const simulations = await rehearseFuture({
    subjectId,
    cycleId,
    ingredients: highlights.length ? highlights : observations.slice(0, 12),
  });
  report.simulations = simulations.length;
  report.simulationPreview = simulations[0]
    ? `${simulations[0].title}: ${simulations[0].possibleUserMove}`
    : null;

  // 5. DREAM — weave the highlights into a factual first-person diary. The
  // simulations stay separate and are never ingredients for historical memory.
  const diary = await dream(store, subjectId, highlights.length ? highlights : observations.slice(0, 8));
  report.diaryEntry = diary?.content ?? null;

  // 6. DEVELOP — propose slow self changes. Promotion requires repeated real
  // evidence across independent cycles; the diary itself cannot rewrite her.
  if (config.bot.selfEvolution) {
    try {
      report.selfEvolution = await evolveSelf({
        subjectId,
        cycleId,
        diaryText: report.diaryEntry,
        reflections: reflection.created,
        observations,
      });
    } catch (e: any) {
      log.warn(`self-evolution failed for ${subjectId}`, e?.message);
    }
  }

  // 6b. POLICY LAB — diagnose a bounded experiment from repeated observed
  // failures. The candidate is logged only; replay evaluation decides later.
  try {
    const candidate = await diagnosePolicyCandidate({ subjectId, cycleId });
    report.policyCandidate = candidate
      ? `${candidate.data.parameter}: ${candidate.data.currentValue} -> ${candidate.data.proposedValue}`
      : null;
    if (candidate) {
      const decision = await evaluateDiagnosedPolicyCandidate(candidate);
      report.policyDecision = `${decision.data.decision}: ${decision.data.parameter}`;
    }
  } catch (e: any) {
    log.warn(`policy diagnosis failed for ${subjectId}`, e?.message ?? e);
  }

  // 7. FORGET
  report.pruned = await forget(store, subjectId);

  log.info(
    `subject=${subjectId} cycle done: +${report.factsAdded} ~${report.factsUpdated} -${report.factsDeleted} facts, ` +
      `${report.insights} insights, ${report.simulations} simulations, ${report.policyCandidate ? '1 policy experiment, ' : ''}${report.pruned} pruned`,
  );
  return report;
}
