import { affinityStore } from '../cognition/affinity.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { memoryPrivacy } from '../memory/privacy.js';
import { getDevelopmentStore } from './eventStore.js';
import { recordUtilityUpdates } from './utility.js';
import type {
  CognitiveStateEventData,
  DevelopmentEvent,
  PredictionResolutionEventData,
  ResponseLinkEventData,
  SocialOutcomeEventData,
  SocialPrediction,
  SocialSignal,
} from './types.js';

const log = logger('development:outcomes');

const POSITIVE_REACTIONS = new Set(['👍', '✅', '⭐', '🌟', '❤️', '❤', '💖', '🔥', '😂', '🤣', '🫶']);
const NEGATIVE_REACTIONS = new Set(['👎', '❌', '⚠️', '😡', '🤬']);

export async function linkDiscordResponse(args: {
  responseMessageIds: string[];
  requestMessageId: string;
  subjectId: string;
  channelId: string;
  turnTraceId?: string | null;
  cognitiveStateId?: string | null;
  predictions: SocialPrediction[];
  memoryIds: string[];
  strategyKeys: string[];
}): Promise<void> {
  if (!config.development.enabled) return;
  const store = getDevelopmentStore();
  for (const responseMessageId of [...new Set(args.responseMessageIds.filter(Boolean))]) {
    const data: ResponseLinkEventData = {
      responseMessageId,
      requestMessageId: args.requestMessageId,
      turnTraceId: args.turnTraceId ?? undefined,
      cognitiveStateId: args.cognitiveStateId ?? undefined,
      predictionIds: args.predictions.map((prediction) => prediction.id),
      memoryIds: [...new Set(args.memoryIds)],
      strategyKeys: [...new Set(args.strategyKeys)],
      authorId: args.subjectId,
    };
    await store.append<ResponseLinkEventData>({
      kind: 'response_link',
      subjectId: args.subjectId,
      channelId: args.channelId,
      evidenceIds: [`discord-message:${args.requestMessageId}`, `discord-response:${responseMessageId}`],
      dedupeKey: `response-link:${responseMessageId}`,
      data,
    });
  }
}

export async function observeFollowupMessage(args: {
  messageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorIsBot?: boolean;
  content: string;
  createdAt?: Date;
  referencedMessageId?: string | null;
  /** True for a DM or an explicit mention. Replies are detected from referencedMessageId. */
  directedAtBot?: boolean;
}): Promise<void> {
  if (!config.development.enabled || args.authorIsBot || !args.content.trim()) return;
  const createdAt = args.createdAt ?? new Date();
  const referenced = args.referencedMessageId ? await responseLinkByMessageId(args.referencedMessageId) : null;
  if (!referenced && !args.directedAtBot) return;
  const link = referenced ?? (await latestEligibleResponse(args.channelId, createdAt, args.authorId));
  if (!link) return;
  if (await outcomeMemoryPaused(link.subjectId, args.authorId)) return;
  const signal = classifyFollowup(args.content);
  await recordOutcome({
    link,
    authorId: args.authorId,
    authorName: args.authorName,
    signal,
    reward: rewardForSignal(signal),
    source: 'message',
    attribution: referenced ? 'reply' : 'addressed',
    detail: clamp(args.content, 500),
    evidenceId: `discord-message:${args.messageId}`,
    dedupeKey: `outcome:message:${args.messageId}:${link.data.responseMessageId}`,
  });
}

export async function observeReaction(args: {
  responseMessageId: string;
  channelId: string;
  authorId: string;
  authorName: string;
  emoji: string;
}): Promise<void> {
  if (!config.development.enabled) return;
  const link = await responseLinkByMessageId(args.responseMessageId);
  if (!link) return;
  if (await outcomeMemoryPaused(link.subjectId, args.authorId)) return;
  const signal: SocialSignal = POSITIVE_REACTIONS.has(args.emoji)
    ? 'reaction_positive'
    : NEGATIVE_REACTIONS.has(args.emoji)
      ? 'reaction_negative'
      : 'reaction_neutral';
  await recordOutcome({
    link,
    authorId: args.authorId,
    authorName: args.authorName,
    signal,
    reward: rewardForSignal(signal),
    source: 'reaction',
    attribution: 'reaction',
    detail: args.emoji,
    evidenceId: `discord-reaction:${args.responseMessageId}:${args.authorId}:${args.emoji}`,
    dedupeKey: `outcome:reaction:${args.responseMessageId}:${args.authorId}:${args.emoji}`,
  });
}

async function recordOutcome(args: {
  link: DevelopmentEvent<ResponseLinkEventData>;
  authorId: string;
  authorName: string;
  signal: SocialSignal;
  reward: number;
  source: SocialOutcomeEventData['source'];
  attribution: SocialOutcomeEventData['attribution'];
  detail: string;
  evidenceId: string;
  dedupeKey: string;
}): Promise<void> {
  const store = getDevelopmentStore();
  const alreadyRecorded = await store.hasDedupeKey(args.dedupeKey);
  const data: SocialOutcomeEventData = {
    responseMessageId: args.link.data.responseMessageId,
    authorId: args.authorId,
    targetAuthor: args.authorId === args.link.data.authorId,
    signal: args.signal,
    reward: args.reward,
    source: args.source,
    attribution: args.attribution,
    detail: args.detail,
  };
  const { event: outcome, created } = await store.appendWithStatus<SocialOutcomeEventData>({
    kind: 'social_outcome',
    subjectId: args.link.subjectId,
    channelId: args.link.channelId,
    evidenceIds: [...args.link.evidenceIds, args.evidenceId],
    dedupeKey: args.dedupeKey,
    data,
  });
  if (alreadyRecorded || !created) return;

  if (data.targetAuthor) {
    const utilityUpdates = !shouldUpdateOutcomeUtility(args.reward)
      ? []
      : [
          recordUtilityUpdates({
            targetType: 'memory',
            targetIds: args.link.data.memoryIds,
            reward: args.reward,
            outcomeId: outcome.id,
            subjectId: args.link.subjectId,
            channelId: args.link.channelId,
            evidenceIds: outcome.evidenceIds,
          }),
          recordUtilityUpdates({
            targetType: 'strategy',
            targetIds: args.link.data.strategyKeys,
            reward: args.reward,
            outcomeId: outcome.id,
            subjectId: args.link.subjectId,
            channelId: args.link.channelId,
            evidenceIds: outcome.evidenceIds,
          }),
        ];
    await Promise.all([...utilityUpdates, resolveOpenPredictions(outcome)]);
  }

  if (args.authorId === args.link.data.authorId && Math.abs(args.reward) >= 0.5) {
    await affinityStore.applyOutcome({
      userId: args.authorId,
      userName: args.authorName,
      evidenceKey: outcome.id,
      valence: args.reward,
      warmth: clampNumber(0.5 + args.reward * 0.35, 0, 1),
    });
  }
}

async function resolveOpenPredictions(
  outcome: DevelopmentEvent<SocialOutcomeEventData>,
): Promise<void> {
  const store = getDevelopmentStore();
  const since = new Date(Date.parse(outcome.timestamp) - config.development.outcomeWindowHours * 3_600_000);
  const [links, subjectOutcomes, resolutionEvents] = await Promise.all([
    store.list({ kinds: ['response_link'], subjectId: outcome.subjectId, channelId: outcome.channelId, since }),
    store.list({ kinds: ['social_outcome'], subjectId: outcome.subjectId, channelId: outcome.channelId, since }),
    store.list({ kinds: ['prediction_resolution'], subjectId: outcome.subjectId }),
  ]);
  const resolved = new Set(
    resolutionEvents.flatMap((event) => predictionIdFromResolution(event.data)),
  );
  for (const rawLink of links) {
    if (!isResponseLinkData(rawLink.data) || !rawLink.data.cognitiveStateId || rawLink.data.predictionIds.length === 0) continue;
    const linkData = rawLink.data;
    const cognitiveStateId = linkData.cognitiveStateId!;
    if (linkData.authorId !== outcome.data.authorId || Date.parse(rawLink.timestamp) >= Date.parse(outcome.timestamp)) continue;
    const stateEvent = await store.get(cognitiveStateId);
    const predictions = isCognitiveStateData(stateEvent?.data) ? stateEvent.data.state.predictions : [];
    const turnDistance = subjectOutcomes.filter(
      (event) =>
        Date.parse(event.timestamp) > Date.parse(rawLink.timestamp) &&
        Date.parse(event.timestamp) <= Date.parse(outcome.timestamp) &&
        isSocialOutcomeData(event.data) &&
        event.data.targetAuthor &&
        (event.data.attribution != null || event.data.source === 'reaction') &&
        event.data.authorId === linkData.authorId,
    ).length;
    for (const prediction of predictions) {
      if (!linkData.predictionIds.includes(prediction.id) || resolved.has(prediction.id)) continue;
      const decision = predictionResolutionForObservation({
        predicted: prediction.signal,
        observed: outcome.data.signal,
        observedReward: outcome.data.reward,
        turnDistance,
        horizonTurns: prediction.horizonTurns,
      });
      if (!decision) continue;
      const data: PredictionResolutionEventData = {
        resolutionRule: 'match_or_signal_v2',
        predictionId: prediction.id,
        responseMessageId: linkData.responseMessageId,
        predictedSignal: prediction.signal,
        observedSignal: outcome.data.signal,
        matched: decision.matched,
        reward: decision.reward,
      };
      const { event: resolution, created } = await store.appendWithStatus<PredictionResolutionEventData>({
        kind: 'prediction_resolution',
        subjectId: rawLink.subjectId,
        channelId: rawLink.channelId,
        evidenceIds: outcome.evidenceIds,
        dedupeKey: `prediction-resolution:${prediction.id}`,
        data,
      });
      if (!created) continue;
      resolved.add(prediction.id);
      await recordUtilityUpdates({
        targetType: 'prediction',
        targetIds: [prediction.signal],
        reward: decision.reward,
        outcomeId: resolution.id,
        subjectId: rawLink.subjectId,
        channelId: rawLink.channelId,
        evidenceIds: resolution.evidenceIds,
      });
    }
  }
}

async function latestEligibleResponse(
  channelId: string,
  before: Date,
  authorId: string,
): Promise<DevelopmentEvent<ResponseLinkEventData> | null> {
  const since = new Date(before.getTime() - config.development.implicitOutcomeWindowMinutes * 60_000);
  const links = await getDevelopmentStore().list({ kinds: ['response_link'], channelId, since, limit: 30 });
  for (let index = links.length - 1; index >= 0; index--) {
    const link = links[index] as DevelopmentEvent<ResponseLinkEventData> | undefined;
    if (!link || Date.parse(link.timestamp) >= before.getTime()) continue;
    if (isResponseLinkData(link.data) && link.data.authorId === authorId) return link;
  }
  return null;
}

async function responseLinkByMessageId(messageId: string): Promise<DevelopmentEvent<ResponseLinkEventData> | null> {
  const cutoff = Date.now() - config.development.outcomeWindowHours * 3_600_000;
  const links = await getDevelopmentStore().list({ kinds: ['response_link'], since: new Date(cutoff) });
  for (let index = links.length - 1; index >= 0; index--) {
    const link = links[index] as DevelopmentEvent<ResponseLinkEventData> | undefined;
    if (link && Date.parse(link.timestamp) >= cutoff && isResponseLinkData(link.data) && link.data.responseMessageId === messageId) return link;
  }
  return null;
}

export function classifyFollowup(content: string): SocialSignal {
  const text = content.toLowerCase();
  if (/\b(wrong|incorrect|actually|no[, ]|not what i (?:said|asked|meant)|you (?:forgot|missed)|that's not|that is not|stop making|made that up)\b/i.test(text)) {
    return 'correction';
  }
  if (/\b(bad answer|that sucked|not helpful|you failed|you are not listening)\b/i.test(text)) return 'negative_feedback';
  if (/\b(exactly|that's right|that is right|perfect|good answer|nice|love it|thank you|thanks)\b/i.test(text)) return 'positive_feedback';
  if (/\?|\b(why|how|what|when|where|who|can you|could you|do you|did you|is it|are you)\b/i.test(content)) {
    return 'follow_up_question';
  }
  return 'topic_continuation';
}

export function rewardForSignal(signal: SocialSignal): number {
  switch (signal) {
    case 'positive_feedback':
      return 0.85;
    case 'reaction_positive':
      return 0.75;
    case 'negative_feedback':
      return -0.8;
    case 'reaction_negative':
      return -0.7;
    case 'correction':
      return -1;
    case 'follow_up_question':
      return 0;
    case 'topic_continuation':
      return 0;
    default:
      return 0;
  }
}

function signalsMatch(predicted: SocialSignal, observed: SocialSignal): boolean {
  if (predicted === observed) return true;
  if (predicted === 'positive_feedback' && observed === 'reaction_positive') return true;
  if (predicted === 'negative_feedback' && (observed === 'reaction_negative' || observed === 'correction')) return true;
  return false;
}

export function predictionResolutionForObservation(args: {
  predicted: SocialSignal;
  observed: SocialSignal;
  observedReward: number;
  turnDistance: number;
  horizonTurns: number;
}): { matched: boolean; reward: number } | null {
  if (signalsMatch(args.predicted, args.observed)) {
    return { matched: true, reward: args.observedReward === 0 ? 0.25 : 1 };
  }
  if (args.observedReward !== 0 || args.turnDistance >= args.horizonTurns) {
    return { matched: false, reward: -0.25 };
  }
  return null;
}

export function shouldUpdateOutcomeUtility(reward: number): boolean {
  return Number.isFinite(reward) && reward !== 0;
}

function isResponseLinkData(value: unknown): value is ResponseLinkEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<ResponseLinkEventData>;
  return typeof data.responseMessageId === 'string' && Array.isArray(data.memoryIds) && Array.isArray(data.predictionIds);
}

function predictionIdFromResolution(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const predictionId = (value as { predictionId?: unknown }).predictionId;
  return typeof predictionId === 'string' ? [predictionId] : [];
}

function isSocialOutcomeData(value: unknown): value is SocialOutcomeEventData {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { authorId?: unknown }).authorId === 'string' &&
      typeof (value as { targetAuthor?: unknown }).targetAuthor === 'boolean',
  );
}

function isCognitiveStateData(value: unknown): value is CognitiveStateEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = (value as { state?: unknown }).state;
  return Boolean(
    state &&
      typeof state === 'object' &&
      !Array.isArray(state) &&
      Array.isArray((state as { predictions?: unknown }).predictions),
  );
}

function clamp(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

async function outcomeMemoryPaused(subjectId: string | undefined, actorId: string): Promise<boolean> {
  if (await memoryPrivacy.isOptedOut(actorId)) return true;
  return subjectId ? memoryPrivacy.isOptedOut(subjectId) : false;
}
