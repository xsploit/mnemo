import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDevelopmentStore } from './eventStore.js';
import { getEffectiveDevelopmentPolicy } from './effectivePolicy.js';
import { readTurnTraces } from '../bot/turnTrace.js';
import type {
  CognitiveStateEventData,
  DevelopmentEvent,
  PolicyCandidateEventData,
  PolicyDecisionEventData,
  PredictionResolutionEventData,
  ResponseLinkEventData,
  SocialOutcomeEventData,
} from './types.js';

export interface ReplayMetrics {
  grounding: number | null;
  speakerAttribution: number | null;
  temporalRecall: number | null;
  personaConsistency: number | null;
  predictionPrecision: number | null;
  latencyMs: number | null;
  contextChars: number | null;
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
  const resolutionEvents = (await store.list({ kinds: ['prediction_resolution'], subjectId: args.subjectId, limit: 40 }))
    .flatMap((event) => (isResolution(event.data) ? [{ event, data: event.data }] : []));
  const resolutions = resolutionEvents.map(({ data }) => data);

  let candidate: PolicyCandidateEventData | null = null;
  let evidenceIds: string[] = [];
  if (resolutions.length >= 8) {
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

/**
 * Run the policy candidate against recorded observations. Only parameters with
 * a real counterfactual in the event log are eligible for automatic promotion.
 */
export async function evaluateDiagnosedPolicyCandidate(
  candidate: DevelopmentEvent<PolicyCandidateEventData>,
): Promise<DevelopmentEvent<PolicyDecisionEventData>> {
  if (candidate.data.parameter !== 'development.maxPredictions') {
    return appendDeferredDecision(candidate, 'no_observed_counterfactual_for_parameter');
  }
  const baseline = await observedReplayMetrics(candidate.subjectId, Math.max(1, Math.trunc(candidate.data.currentValue)));
  const proposed = await observedReplayMetrics(candidate.subjectId, Math.max(1, Math.trunc(candidate.data.proposedValue)));
  if (baseline.predictionPrecision == null || proposed.predictionPrecision == null) {
    return appendDeferredDecision(candidate, 'insufficient_resolved_predictions');
  }
  return evaluatePolicyCandidate({ candidate, baseline, proposed });
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
    const baselineValue = baseline[metric];
    const proposedValue = proposed[metric];
    if (baselineValue != null && proposedValue != null && proposedValue + boundedRegression < baselineValue) regressions.push(metric);
  }
  if (baseline.latencyMs != null && proposed.latencyMs != null && proposed.latencyMs > baseline.latencyMs * 1.25 + 50) regressions.push('latencyMs');
  if (baseline.contextChars != null && proposed.contextChars != null && proposed.contextChars > baseline.contextChars * 1.2 + 500) regressions.push('contextChars');

  const baselineTarget = metricValue(targetMetric, baseline);
  const proposedTarget = metricValue(targetMetric, proposed);
  if (baselineTarget == null || proposedTarget == null) {
    return { decision: 'deferred', regressions: [...regressions, 'insufficient_target_metric'] };
  }
  const target = proposedTarget - baselineTarget;
  const decision: PolicyDecisionEventData['decision'] = regressions.length === 0 && target >= 0.01 ? 'promoted' : 'rejected';
  return { decision, regressions };
}

function metricValue(name: string, metrics: ReplayMetrics): number | null {
  if (name === 'predictionPrecision') return metrics.predictionPrecision;
  if (name === 'grounding') return metrics.grounding;
  if (name === 'speakerAttribution') return metrics.speakerAttribution;
  if (name === 'temporalRecall') return metrics.temporalRecall;
  if (name === 'personaConsistency') return metrics.personaConsistency;
  return metrics.overall;
}

async function observedReplayMetrics(subjectId: string | undefined, maxPredictions: number): Promise<ReplayMetrics> {
  const store = getDevelopmentStore();
  const [events, traces] = await Promise.all([
    store.list({ subjectId }),
    readTurnTraces().then((rows) => rows.filter((trace) => !subjectId || trace.subjectId === subjectId)),
  ]);
  const selectedPredictionIds = new Set<string>();
  for (const event of events) {
    if (!isCognitiveState(event.data)) continue;
    const selected = [...event.data.state.predictions]
      .sort((left, right) => right.probability - left.probability)
      .slice(0, maxPredictions);
    for (const prediction of selected) selectedPredictionIds.add(prediction.id);
  }
  const resolutions = events
    .flatMap((event) => (isResolution(event.data) && selectedPredictionIds.has(event.data.predictionId) ? [event.data] : []));
  const allOutcomes = events
    .flatMap((event) => (isOutcome(event.data) ? [event.data] : []))
    .filter((outcome) => outcome.attribution != null || outcome.source === 'reaction');
  const outcomes = allOutcomes.filter((outcome) => outcome.targetAuthor);
  const responseAuthors = new Map(
    events.flatMap((event) => (isResponseLink(event.data) ? [[event.data.responseMessageId, event.data.authorId] as const] : [])),
  );
  const attributionChecks = allOutcomes.flatMap((outcome) => {
    const expectedAuthor = responseAuthors.get(outcome.responseMessageId);
    return expectedAuthor ? [outcome.targetAuthor === (outcome.authorId === expectedAuthor)] : [];
  });
  const corrections = outcomes.filter((outcome) =>
    outcome.signal === 'correction' || outcome.signal === 'negative_feedback' || outcome.signal === 'reaction_negative'
  ).length;
  const recallTraces = traces.filter((trace) => /\b(remember|recall|last night|yesterday|we talked|talked about)\b/i.test(trace.prompt));
  const latencyValues = traces.flatMap((trace) => trace.latency
    ? [trace.latency.memoryMs + trace.latency.contextMs + trace.latency.cognitiveMs + trace.latency.generationMs + trace.latency.recallRepairMs + trace.latency.preSendMs]
    : []);
  const contextValues = traces.map((trace) => trace.systemChars + trace.promptChars);
  const personaFormatted = traces.filter((trace) => trace.answer.trim().length > 0 && trace.answer.length <= 8000).length;
  const grounding = ratio(outcomes.length - corrections, outcomes.length);
  const speakerAttribution = ratio(attributionChecks.filter(Boolean).length, attributionChecks.length);
  const temporalRecall = ratio(recallTraces.filter((trace) => trace.retrieved.length > 0).length, recallTraces.length);
  const personaConsistency = ratio(personaFormatted, traces.length);
  const predictionPrecision = ratio(resolutions.filter((resolution) => resolution.matched).length, resolutions.length);
  const qualityValues = [grounding, speakerAttribution, temporalRecall, personaConsistency, predictionPrecision]
    .filter((value): value is number => value != null);
  return {
    grounding,
    speakerAttribution,
    temporalRecall,
    personaConsistency,
    predictionPrecision,
    latencyMs: latencyValues.length ? mean(latencyValues) : null,
    contextChars: contextValues.length ? mean(contextValues) : null,
    overall: qualityValues.length ? mean(qualityValues) : 0,
  };
}

async function appendDeferredDecision(
  candidate: DevelopmentEvent<PolicyCandidateEventData>,
  reason: string,
): Promise<DevelopmentEvent<PolicyDecisionEventData>> {
  const data: PolicyDecisionEventData = {
    ...candidate.data,
    decision: 'deferred',
    baselineScore: 0,
    candidateScore: 0,
    regressions: [reason],
  };
  return getDevelopmentStore().append<PolicyDecisionEventData>({
    kind: 'policy_decision',
    subjectId: candidate.subjectId,
    evidenceIds: candidate.evidenceIds,
    dedupeKey: `policy-decision:${candidate.data.policyId}`,
    data,
  });
}

function isCognitiveState(value: unknown): value is CognitiveStateEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { state?: { predictions?: unknown } }).state &&
      Array.isArray((value as { state: { predictions: unknown } }).state.predictions),
  );
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isOutcome(value: unknown): value is SocialOutcomeEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { signal?: unknown }).signal === 'string' &&
      typeof (value as { targetAuthor?: unknown }).targetAuthor === 'boolean',
  );
}

function isResponseLink(value: unknown): value is ResponseLinkEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { responseMessageId?: unknown }).responseMessageId === 'string' &&
      typeof (value as { authorId?: unknown }).authorId === 'string',
  );
}

function isResolution(value: unknown): value is PredictionResolutionEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { resolutionRule?: unknown }).resolutionRule === 'match_or_signal_v2' &&
      typeof (value as { matched?: unknown }).matched === 'boolean',
  );
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
