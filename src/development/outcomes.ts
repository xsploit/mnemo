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
  content: string;
  createdAt?: Date;
  referencedMessageId?: string | null;
}): Promise<void> {
  if (!config.development.enabled || !args.content.trim()) return;
  const createdAt = args.createdAt ?? new Date();
  const referenced = args.referencedMessageId ? await responseLinkByMessageId(args.referencedMessageId) : null;
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
    detail: args.detail,
  };
  const outcome = await store.append<SocialOutcomeEventData>({
    kind: 'social_outcome',
    subjectId: args.link.subjectId,
    channelId: args.link.channelId,
    evidenceIds: [...args.link.evidenceIds, args.evidenceId],
    dedupeKey: args.dedupeKey,
    data,
  });
  if (alreadyRecorded) return;

  if (data.targetAuthor) {
    await Promise.all([
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
      resolvePredictions(args.link, outcome),
    ]);
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

async function resolvePredictions(
  link: DevelopmentEvent<ResponseLinkEventData>,
  outcome: DevelopmentEvent<SocialOutcomeEventData>,
): Promise<void> {
  if (!link.data.cognitiveStateId || link.data.predictionIds.length === 0) return;
  const stateEvent = await getDevelopmentStore().get(link.data.cognitiveStateId);
  const predictions = isCognitiveStateData(stateEvent?.data) ? stateEvent.data.state.predictions : [];
  const resolved = new Set(
    (await getDevelopmentStore().list({ kinds: ['prediction_resolution'], subjectId: link.subjectId, limit: 1000 }))
      .flatMap((event) => (isPredictionResolutionData(event.data) ? [event.data.predictionId] : [])),
  );
  for (const prediction of predictions) {
    if (!link.data.predictionIds.includes(prediction.id)) continue;
    if (resolved.has(prediction.id)) continue;
    const matched = signalsMatch(prediction.signal, outcome.data.signal);
    const reward = matched ? 1 : -0.25;
    const data: PredictionResolutionEventData = {
      predictionId: prediction.id,
      responseMessageId: link.data.responseMessageId,
      predictedSignal: prediction.signal,
      observedSignal: outcome.data.signal,
      matched,
      reward,
    };
    const resolution = await getDevelopmentStore().append<PredictionResolutionEventData>({
      kind: 'prediction_resolution',
      subjectId: link.subjectId,
      channelId: link.channelId,
      evidenceIds: outcome.evidenceIds,
      dedupeKey: `prediction-resolution:${prediction.id}:${outcome.id}`,
      data,
    });
    await recordUtilityUpdates({
      targetType: 'prediction',
      targetIds: [prediction.signal],
      reward,
      outcomeId: resolution.id,
      subjectId: link.subjectId,
      channelId: link.channelId,
      evidenceIds: resolution.evidenceIds,
    });
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
  const links = await getDevelopmentStore().list({ kinds: ['response_link'], limit: 500 });
  const cutoff = Date.now() - config.development.outcomeWindowHours * 3_600_000;
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

function isResponseLinkData(value: unknown): value is ResponseLinkEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Partial<ResponseLinkEventData>;
  return typeof data.responseMessageId === 'string' && Array.isArray(data.memoryIds) && Array.isArray(data.predictionIds);
}

function isPredictionResolutionData(value: unknown): value is PredictionResolutionEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (value as { predictionId?: unknown }).predictionId === 'string';
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
