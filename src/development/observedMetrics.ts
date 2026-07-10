import type { DevelopmentEventStore } from './eventStore.js';
import type {
  CognitiveStateEventData,
  PredictionResolutionEventData,
  SocialOutcomeEventData,
  UtilityUpdateEventData,
} from './types.js';

export interface ObservedDevelopmentMetrics {
  outcomes: number;
  messageOutcomes: number;
  reactionOutcomes: number;
  positiveRate: number | null;
  correctionRate: number | null;
  continuationRate: number | null;
  meanReward: number | null;
  predictionResolutions: number;
  predictionPrecision: number | null;
  predictionBrier: number | null;
  utilityUpdates: number;
}

export async function computeObservedDevelopmentMetrics(
  store: DevelopmentEventStore,
  subjectId?: string,
): Promise<ObservedDevelopmentMetrics> {
  const events = await store.list({ subjectId, limit: 5000 });
  const outcomes = events.flatMap((event) => (isOutcome(event.data) ? [event.data] : []));
  const resolutions = events.flatMap((event) => (isResolution(event.data) ? [event.data] : []));
  const utilityUpdates = events.filter((event) => isUtilityUpdate(event.data)).length;
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
    messageOutcomes: messageOutcomes.length,
    reactionOutcomes: outcomes.length - messageOutcomes.length,
    positiveRate: ratio(positives, outcomes.length),
    correctionRate: ratio(corrections, outcomes.length),
    continuationRate: ratio(continuations, messageOutcomes.length),
    meanReward: outcomes.length ? mean(outcomes.map((outcome) => outcome.reward)) : null,
    predictionResolutions: resolutions.length,
    predictionPrecision: resolutions.length
      ? resolutions.filter((resolution) => resolution.matched).length / resolutions.length
      : null,
    predictionBrier: brierTerms.length ? mean(brierTerms) : null,
    utilityUpdates,
  };
}

function isOutcome(value: unknown): value is SocialOutcomeEventData {
  if (!isRecord(value)) return false;
  return (
    typeof value.signal === 'string' &&
    typeof value.reward === 'number' &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
