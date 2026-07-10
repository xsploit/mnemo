import { z } from 'zod';
import { config } from '../config.js';
import { getDevelopmentStore } from '../development/eventStore.js';
import type {
  DevelopmentEvent,
  SelfDeltaCandidateEventData,
  SelfDeltaDecisionEventData,
} from '../development/types.js';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';
import { logger } from '../logger.js';
import type { MemoryRecord } from '../memory/types.js';
import { selfModelStore, type SelfNoteEdit } from './selfModel.js';

const log = logger('self-reflect');
let selfEvaluationTail: Promise<unknown> = Promise.resolve();

const candidateSchema = z.object({
  candidates: z
    .array(
      z.object({
        traitKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,47}$/),
        op: z.enum(['add', 'revise', 'drop']),
        note: z.string().max(180).optional(),
        targetIndex: z.number().int().nullable().optional(),
        confidence: z.number().min(0).max(1),
        reason: z.string().max(260),
        basis: z.array(z.number().int().min(0)).max(10),
      }),
    )
    .max(2),
});

/**
 * Slow developmental self-reflection. The model may propose evidence-linked
 * changes, but it cannot directly rewrite Hikari's self-model. A trait must
 * recur across independent sleep cycles and distinct evidence before promotion.
 */
export async function evolveSelf(args: {
  subjectId: string;
  cycleId: string;
  diaryText: string | null;
  reflections: MemoryRecord[];
  observations: MemoryRecord[];
}): Promise<string[]> {
  if (!config.development.enabled) return [];
  const current = await selfModelStore.get();
  const evidence = args.observations.slice(0, 30);
  if (evidence.length === 0) return [];
  const numbered = evidence.map((memory, index) => `${index}. [${memory.id}] (${memory.kind}) ${memory.content}`).join('\n');
  const reflectionContext = args.reflections.length
    ? args.reflections.slice(0, 10).map((memory) => `- ${memory.content}`).join('\n')
    : '(none)';
  const notes = current.selfNotes.length ? current.selfNotes.map((note, index) => `[${index}] ${note}`).join('\n') : '(none)';

  let rawCandidates: z.infer<typeof candidateSchema>['candidates'] = [];
  try {
    const { object } = await reasonedObject({
      model: models.json,
      schema: candidateSchema,
      system: `You propose slow, evidence-grounded changes to Hikari's first-person self-concept.

You do not edit the self-model. You only propose candidates for later deterministic review.

Rules:
- Most sleep cycles should propose nothing.
- A candidate must describe Hikari, not facts about another person.
- Generated mood, diary prose, and reflection hypotheses are not evidence. Cite lived-observation indices only.
- Use a stable traitKey so the same underlying trait can accumulate support across nights.
- Prefer small, specific, behaviorally meaningful changes. Never rewrite the core persona.
- Add needs a concise first-person note. Revise/drop needs a valid current-note index.
- Confidence measures evidence strength, not writing confidence.`,
      prompt: `Current self-notes:\n${notes}\n\nTonight's diary is context only:\n${args.diaryText ?? '(none)'}\n\nReflection hypotheses are context only and cannot be cited:\n${reflectionContext}\n\nEvidence from lived interactions:\n${numbered}`,
      temperature: 0.25,
      maxOutputTokens: 1200,
    });
    rawCandidates = object.candidates;
  } catch (error: any) {
    log.warn('self-delta proposal failed; self-model unchanged', error?.message ?? error);
    return [];
  }

  const store = getDevelopmentStore();
  const created: DevelopmentEvent<SelfDeltaCandidateEventData>[] = [];
  for (const candidate of rawCandidates) {
    const evidenceIds = [...new Set(candidate.basis.map((index) => evidence[index]?.id).filter((id): id is string => Boolean(id)))];
    if (evidenceIds.length === 0 || candidate.confidence < 0.55) continue;
    if (candidate.op === 'add' && !candidate.note?.trim()) continue;
    if ((candidate.op === 'revise' || candidate.op === 'drop') && candidate.targetIndex == null) continue;
    const data: SelfDeltaCandidateEventData = {
      cycleId: args.cycleId,
      traitKey: candidate.traitKey,
      op: candidate.op,
      note: candidate.note?.trim(),
      targetIndex: candidate.targetIndex,
      confidence: candidate.confidence,
      reason: candidate.reason,
    };
    const event = await store.append<SelfDeltaCandidateEventData>({
      kind: 'self_delta_candidate',
      subjectId: args.subjectId,
      evidenceIds: evidenceIds.map((id) => `memory:${id}`),
      dedupeKey: `self-delta-candidate:${args.cycleId}:${candidate.traitKey}:${candidate.op}`,
      data,
    });
    created.push(event);
  }

  const changes: string[] = [];
  for (const candidate of created) {
    const decision = await evaluateCandidate(candidate);
    if (decision) changes.push(decision);
  }
  return changes;
}

async function evaluateCandidate(candidate: DevelopmentEvent<SelfDeltaCandidateEventData>): Promise<string | null> {
  const operation = selfEvaluationTail.then(() => evaluateCandidateSerialized(candidate));
  selfEvaluationTail = operation.catch(() => undefined);
  return operation;
}

async function evaluateCandidateSerialized(candidate: DevelopmentEvent<SelfDeltaCandidateEventData>): Promise<string | null> {
  const store = getDevelopmentStore();
  const allCandidates = (await store.list({ kinds: ['self_delta_candidate'] }))
    .flatMap((event) =>
      isCandidateData(event.data)
        ? [event as unknown as DevelopmentEvent<SelfDeltaCandidateEventData>]
        : [],
    )
    .filter((event) => event.data.traitKey === candidate.data.traitKey && event.data.op === candidate.data.op);
  const accepted = (await store.list({ kinds: ['self_delta_decision'] })).some((event) => {
    const data = event.data as Partial<SelfDeltaDecisionEventData>;
    return data.traitKey === candidate.data.traitKey && data.op === candidate.data.op && data.decision === 'accepted';
  });
  if (accepted) return null;

  const evidenceIds = [...new Set(allCandidates.flatMap((event) => event.evidenceIds))];
  const cycleIds = [...new Set(allCandidates.map((event) => event.data.cycleId))];
  const thresholdMet = meetsSelfDeltaThreshold(
    evidenceIds,
    cycleIds,
    config.development.selfDeltaMinEvidence,
    config.development.selfDeltaMinCycles,
  );

  let decision: SelfDeltaDecisionEventData['decision'] = 'deferred';
  let changed: string[] = [];
  if (thresholdMet) {
    const strongest = [...allCandidates].sort((left, right) => right.data.confidence - left.data.confidence)[0]!;
    const edit: SelfNoteEdit = {
      op: strongest.data.op,
      note: strongest.data.note,
      targetIndex: strongest.data.targetIndex,
    };
    const result = await selfModelStore.evolve({ noteEdits: [edit] });
    changed = result.changed;
    decision = changed.length ? 'accepted' : 'rejected';
  }

  const data: SelfDeltaDecisionEventData = {
    ...candidate.data,
    candidateIds: allCandidates.map((event) => event.id),
    decision,
    uniqueEvidenceCount: evidenceIds.length,
    uniqueCycleCount: cycleIds.length,
  };
  await store.append<SelfDeltaDecisionEventData>({
    kind: 'self_delta_decision',
    subjectId: candidate.subjectId,
    evidenceIds,
    dedupeKey: `self-delta-decision:${candidate.data.cycleId}:${candidate.data.traitKey}:${candidate.data.op}`,
    data,
  });
  if (decision === 'deferred') {
    log.info(
      `self delta ${candidate.data.traitKey} deferred: evidence=${evidenceIds.length}/${config.development.selfDeltaMinEvidence} cycles=${cycleIds.length}/${config.development.selfDeltaMinCycles}`,
    );
  } else if (changed.length) {
    log.info(`self evolved from repeated evidence: ${changed.join('; ')}`);
  }
  return changed[0] ?? null;
}

function isCandidateData(value: unknown): value is SelfDeltaCandidateEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<SelfDeltaCandidateEventData>;
  return typeof data.cycleId === 'string' && typeof data.traitKey === 'string' && ['add', 'revise', 'drop'].includes(data.op ?? '');
}

export function meetsSelfDeltaThreshold(
  evidenceIds: string[],
  cycleIds: string[],
  minEvidence: number,
  minCycles: number,
): boolean {
  return new Set(evidenceIds).size >= minEvidence && new Set(cycleIds).size >= minCycles;
}
