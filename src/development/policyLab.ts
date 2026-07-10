import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDevelopmentStore } from './eventStore.js';
import { getEffectiveDevelopmentPolicy } from './effectivePolicy.js';
import type {
  DevelopmentEvent,
  PolicyCandidateEventData,
  PolicyDecisionEventData,
  PredictionResolutionEventData,
  SocialOutcomeEventData,
} from './types.js';

export interface ReplayMetrics {
  grounding: number;
  speakerAttribution: number;
  temporalRecall: number;
  personaConsistency: number;
  predictionPrecision: number;
  latencyMs: number;
  contextChars: number;
  overall: number;
}

/**
 * Diagnose bounded policy ideas from observed failures. This never applies a
 * value; it only records a candidate for replay evaluation.
 */
export async function diagnosePolicyCandidate(args: {
  subjectId: string;
  cycleId: string;
}): Promise<DevelopmentEvent<PolicyCandidateEventData> | null> {
  if (!config.development.enabled || !config.development.policyLabEnabled) return null;
  const store = getDevelopmentStore();
  const effectivePolicy = await getEffectiveDevelopmentPolicy(store, args.subjectId);
  const outcomeEvents = (await store.list({ kinds: ['social_outcome'], subjectId: args.subjectId, limit: 30 }))
    .flatMap((event) => (isOutcome(event.data) ? [{ event, data: event.data }] : []));
  const resolutionEvents = (await store.list({ kinds: ['prediction_resolution'], subjectId: args.subjectId, limit: 40 }))
    .flatMap((event) => (isResolution(event.data) ? [{ event, data: event.data }] : []));
  const outcomes = outcomeEvents.map(({ data }) => data);
  const resolutions = resolutionEvents.map(({ data }) => data);

  let candidate: PolicyCandidateEventData | null = null;
  let evidenceIds: string[] = [];
  const corrections = outcomes.filter((outcome) => outcome.signal === 'correction' || outcome.signal === 'negative_feedback').length;
  if (outcomes.length >= 8 && corrections / outcomes.length >= 0.3 && effectivePolicy.utilityWeight > 0.05) {
    candidate = {
      policyId: crypto.randomUUID(),
      parameter: 'development.utilityWeight',
      currentValue: effectivePolicy.utilityWeight,
      proposedValue: Math.max(0.05, Number((effectivePolicy.utilityWeight - 0.05).toFixed(2))),
      targetMetric: 'grounding',
      reason: `${corrections}/${outcomes.length} recent outcomes were corrections or explicit negative feedback; test less utility influence on recall`,
    };
    evidenceIds = outcomeEvents
      .filter(({ data }) => data.signal === 'correction' || data.signal === 'negative_feedback')
      .map(({ event }) => `development-event:${event.id}`);
  } else if (resolutions.length >= 8) {
    const precision = resolutions.filter((resolution) => resolution.matched).length / resolutions.length;
    if (precision < 0.45) {
      candidate = {
        policyId: crypto.randomUUID(),
        parameter: 'development.maxPredictions',
        currentValue: effectivePolicy.maxPredictions,
        proposedValue: Math.max(1, effectivePolicy.maxPredictions - 1),
        targetMetric: 'predictionPrecision',
        reason: `recent prediction precision was ${precision.toFixed(2)}; test fewer, higher-confidence predictions`,
      };
      evidenceIds = resolutionEvents.map(({ event }) => `development-event:${event.id}`);
    }
  }
  if (!candidate) return null;

  const openCandidate = (await store.list({ kinds: ['policy_candidate'], subjectId: args.subjectId, limit: 50 }))
    .flatMap((event) => (isPolicyCandidate(event.data) ? [{ event, data: event.data }] : []))
    .reverse()
    .find(({ data }) => data.parameter === candidate!.parameter);
  if (openCandidate) {
    const decided = (await store.list({ kinds: ['policy_decision'], subjectId: args.subjectId, limit: 100 }))
      .some((event) => isPolicyDecision(event.data) && event.data.policyId === openCandidate.data.policyId);
    if (!decided) return null;
  }

  const evidenceFingerprint = crypto
    .createHash('sha256')
    .update([...evidenceIds].sort().join('|'))
    .digest('hex')
    .slice(0, 16);

  return store.append<PolicyCandidateEventData>({
    kind: 'policy_candidate',
    subjectId: args.subjectId,
    evidenceIds,
    dedupeKey: `policy-candidate:${args.subjectId}:${candidate.parameter}:${evidenceFingerprint}`,
    data: candidate,
  });
}

export async function evaluatePolicyCandidate(args: {
  candidate: DevelopmentEvent<PolicyCandidateEventData>;
  baseline: ReplayMetrics;
  proposed: ReplayMetrics;
}): Promise<DevelopmentEvent<PolicyDecisionEventData>> {
  const result = decidePolicyCandidate(args.candidate.data.targetMetric, args.baseline, args.proposed);
  const data: PolicyDecisionEventData = {
    ...args.candidate.data,
    decision: result.decision,
    baselineScore: args.baseline.overall,
    candidateScore: args.proposed.overall,
    regressions: result.regressions,
  };
  return getDevelopmentStore().append<PolicyDecisionEventData>({
    kind: 'policy_decision',
    subjectId: args.candidate.subjectId,
    evidenceIds: args.candidate.evidenceIds,
    dedupeKey: `policy-decision:${args.candidate.data.policyId}`,
    data,
  });
}

export function decidePolicyCandidate(
  targetMetric: string,
  baseline: ReplayMetrics,
  proposed: ReplayMetrics,
): { decision: PolicyDecisionEventData['decision']; regressions: string[] } {
  const regressions: string[] = [];
  const boundedRegression = 0.005;
  for (const metric of ['grounding', 'speakerAttribution', 'temporalRecall', 'personaConsistency'] as const) {
    if (proposed[metric] + boundedRegression < baseline[metric]) regressions.push(metric);
  }
  if (proposed.latencyMs > baseline.latencyMs * 1.25 + 50) regressions.push('latencyMs');
  if (proposed.contextChars > baseline.contextChars * 1.2 + 500) regressions.push('contextChars');

  const target = metricValue(targetMetric, proposed) - metricValue(targetMetric, baseline);
  const decision: PolicyDecisionEventData['decision'] = regressions.length === 0 && target >= 0.01 ? 'promoted' : 'rejected';
  return { decision, regressions };
}

function metricValue(name: string, metrics: ReplayMetrics): number {
  if (name === 'predictionPrecision') return metrics.predictionPrecision;
  if (name === 'grounding') return metrics.grounding;
  if (name === 'speakerAttribution') return metrics.speakerAttribution;
  if (name === 'temporalRecall') return metrics.temporalRecall;
  if (name === 'personaConsistency') return metrics.personaConsistency;
  return metrics.overall;
}

function isOutcome(value: unknown): value is SocialOutcomeEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { signal?: unknown }).signal === 'string' &&
      (value as { targetAuthor?: unknown }).targetAuthor !== false,
  );
}

function isResolution(value: unknown): value is PredictionResolutionEventData {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { matched?: unknown }).matched === 'boolean');
}

function isPolicyCandidate(value: unknown): value is PolicyCandidateEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { policyId?: unknown }).policyId === 'string' &&
      typeof (value as { parameter?: unknown }).parameter === 'string',
  );
}

function isPolicyDecision(value: unknown): value is PolicyDecisionEventData {
  return Boolean(isPolicyCandidate(value) && typeof (value as { decision?: unknown }).decision === 'string');
}
