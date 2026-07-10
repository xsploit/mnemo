import type { DevelopmentEventStore } from './eventStore.js';
import type {
  CognitiveStateEventData,
  PredictionResolutionEventData,
  SocialOutcomeEventData,
  UtilityUpdateEventData,
} from './types.js';

export interface ObservedDevelopmentMetrics {
  outcomes: number;
  externalOutcomes: number;
  messageOutcomes: number;
  reactionOutcomes: number;
  positiveRate: number | null;
  correctionRate: number | null;
  continuationRate: number | null;
  meanReward: number | null;
  predictionResolutions: number;
  predictionsMade: number;
  predictionCoverage: number | null;
  predictionPrecision: number | null;
  predictionBrier: number | null;
  utilityUpdates: number;
  shadowRetrievals: number;
  shadowAcceptedRate: number | null;
  shadowMeanLatencyMs: number | null;
  shadowMeanJaccard: number | null;
}

export async function computeObservedDevelopmentMetrics(
  store: DevelopmentEventStore,
  subjectId?: string,
): Promise<ObservedDevelopmentMetrics> {
  const events = await store.list({ subjectId, limit: 5000 });
  const allOutcomes = events.flatMap((event) => (isOutcome(event.data) ? [event.data] : []));
  const outcomes = allOutcomes.filter((outcome) => outcome.targetAuthor !== false);
  const resolutionByPrediction = new Map<string, PredictionResolutionEventData>();
  for (const event of events) {
    if (isResolution(event.data)) resolutionByPrediction.set(event.data.predictionId, event.data);
  }
  const resolutions = [...resolutionByPrediction.values()];
  const utilityUpdates = events.filter((event) => isUtilityUpdate(event.data)).length;
  const shadowRetrievals = events.flatMap((event) => (isShadowRetrieval(event.data) ? [event.data] : []));
  const shadowJaccards = shadowRetrievals.flatMap((result) => {
    const match = /\bjaccard=([0-9.]+)/i.exec(result.detail);
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? [value] : [];
  });
  const predictionProbability = new Map<string, number>();

  for (const event of events) {
    if (!isCognitiveState(event.data)) continue;
    for (const prediction of event.data.state.predictions) {
      predictionProbability.set(prediction.id, prediction.probability);
    }
  }

  const messageOutcomes = outcomes.filter((outcome) => outcome.source === 'message');
  const positives = outcomes.filter(
    (outcome) => outcome.signal === 'positive_feedback' || outcome.signal === 'reaction_positive',
  ).length;
  const corrections = outcomes.filter(
    (outcome) => outcome.signal === 'correction' || outcome.signal === 'negative_feedback' || outcome.signal === 'reaction_negative',
  ).length;
  const continuations = messageOutcomes.filter(
    (outcome) =>
      outcome.signal === 'topic_continuation' ||
      outcome.signal === 'follow_up_question' ||
      outcome.signal === 'positive_feedback',
  ).length;
  const brierTerms = resolutions.flatMap((resolution) => {
    const probability = predictionProbability.get(resolution.predictionId);
    if (probability == null) return [];
    const observed = resolution.matched ? 1 : 0;
    return [(probability - observed) ** 2];
  });

  return {
    outcomes: outcomes.length,
    externalOutcomes: allOutcomes.length - outcomes.length,
    messageOutcomes: messageOutcomes.length,
    reactionOutcomes: outcomes.length - messageOutcomes.length,
    positiveRate: ratio(positives, outcomes.length),
    correctionRate: ratio(corrections, outcomes.length),
    continuationRate: ratio(continuations, messageOutcomes.length),
    meanReward: outcomes.length ? mean(outcomes.map((outcome) => outcome.reward)) : null,
    predictionResolutions: resolutions.length,
    predictionsMade: predictionProbability.size,
    predictionCoverage: ratio(resolutions.length, predictionProbability.size),
    predictionPrecision: resolutions.length
      ? resolutions.filter((resolution) => resolution.matched).length / resolutions.length
      : null,
    predictionBrier: brierTerms.length ? mean(brierTerms) : null,
    utilityUpdates,
    shadowRetrievals: shadowRetrievals.length,
    shadowAcceptedRate: ratio(shadowRetrievals.filter((result) => result.accepted).length, shadowRetrievals.length),
    shadowMeanLatencyMs: shadowRetrievals.length ? mean(shadowRetrievals.map((result) => result.latencyMs)) : null,
    shadowMeanJaccard: shadowJaccards.length ? mean(shadowJaccards) : null,
  };
}

function isOutcome(value: unknown): value is SocialOutcomeEventData {
  if (!isRecord(value)) return false;
  return (
    typeof value.signal === 'string' &&
    typeof value.reward === 'number' &&
    (value.targetAuthor === undefined || typeof value.targetAuthor === 'boolean') &&
    (value.source === 'message' || value.source === 'reaction')
  );
}

function isResolution(value: unknown): value is PredictionResolutionEventData {
  return (
    isRecord(value) &&
    typeof value.predictionId === 'string' &&
    typeof value.matched === 'boolean'
  );
}

function isCognitiveState(value: unknown): value is CognitiveStateEventData {
  return Boolean(
    isRecord(value) &&
      isRecord(value.state) &&
      Array.isArray(value.state.predictions) &&
      value.state.predictions.every(
        (prediction) =>
          isRecord(prediction) &&
          typeof prediction.id === 'string' &&
          typeof prediction.probability === 'number',
      ),
  );
}

function isUtilityUpdate(value: unknown): value is UtilityUpdateEventData {
  return Boolean(
    isRecord(value) &&
      typeof value.targetId === 'string' &&
      typeof value.next === 'number' &&
      typeof value.outcomeId === 'string',
  );
}

function isShadowRetrieval(value: unknown): value is {
  operation: 'retrieve';
  accepted: boolean;
  latencyMs: number;
  detail: string;
} {
  return Boolean(
    isRecord(value) &&
      value.operation === 'retrieve' &&
      typeof value.accepted === 'boolean' &&
      typeof value.latencyMs === 'number' &&
      typeof value.detail === 'string',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
