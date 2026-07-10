export const DEVELOPMENT_SCHEMA = 'hikari.development.v1' as const;

export type DevelopmentEventKind =
  | 'cognitive_state'
  | 'response_link'
  | 'social_outcome'
  | 'prediction_resolution'
  | 'utility_update'
  | 'dream_simulation'
  | 'self_delta_candidate'
  | 'self_delta_decision'
  | 'policy_candidate'
  | 'policy_decision'
  | 'shadow_memory_result';

export type SocialSignal =
  | 'positive_feedback'
  | 'negative_feedback'
  | 'correction'
  | 'follow_up_question'
  | 'topic_continuation'
  | 'topic_change'
  | 'reaction_positive'
  | 'reaction_negative'
  | 'reaction_neutral';

export interface DevelopmentEvent<T = unknown> {
  schema: typeof DEVELOPMENT_SCHEMA;
  id: string;
  kind: DevelopmentEventKind;
  timestamp: string;
  subjectId?: string;
  channelId?: string;
  evidenceIds: string[];
  dedupeKey?: string;
  data: T;
}

export interface DevelopmentEventInput<T = unknown> {
  kind: DevelopmentEventKind;
  subjectId?: string;
  channelId?: string;
  evidenceIds?: string[];
  dedupeKey?: string;
  data: T;
}

export interface SceneState {
  topic: string;
  tone: string;
  socialContext: string;
}

export interface EventAppraisal {
  novelty: number;
  goalCongruence: number;
  controllability: number;
  certainty: number;
  agency: 'user' | 'self' | 'other' | 'shared' | 'unclear';
}

export interface UserHypothesis {
  likelyIntent: string;
  likelyAffect: string;
  likelyWant: string;
  confidence: number;
  evidenceIds: string[];
}

export interface ResponseIntention {
  primaryGoal: string;
  secondaryGoals: string[];
  directness: number;
  warmth: number;
  playfulness: number;
  depth: number;
}

export interface RelationshipDeltaProposal {
  trustDelta: number;
  warmthDelta: number;
  confidence: number;
  reason: string;
  evidenceIds: string[];
}

export interface SocialPrediction {
  id: string;
  signal: SocialSignal;
  description: string;
  probability: number;
  horizonTurns: number;
  evidenceIds: string[];
}

export interface CognitiveState {
  subjectId: string;
  channelId: string;
  messageId: string;
  scene: SceneState;
  appraisal: EventAppraisal;
  userModel: UserHypothesis;
  response: ResponseIntention;
  relationshipDelta: RelationshipDeltaProposal;
  predictions: SocialPrediction[];
  memoryIds: string[];
  evidenceIds: string[];
  compiler: 'model' | 'deterministic' | 'timeout_fallback' | 'error_fallback';
}

export interface CognitiveStateEventData {
  state: CognitiveState;
}

export interface ResponseLinkEventData {
  responseMessageId: string;
  requestMessageId: string;
  turnTraceId?: string;
  cognitiveStateId?: string;
  predictionIds: string[];
  memoryIds: string[];
  strategyKeys: string[];
  authorId: string;
}

export interface SocialOutcomeEventData {
  responseMessageId: string;
  authorId: string;
  /** True only when feedback came from the person the response addressed. */
  targetAuthor: boolean;
  signal: SocialSignal;
  reward: number;
  source: 'message' | 'reaction';
  attribution: 'reply' | 'addressed' | 'reaction';
  detail: string;
}

export interface PredictionResolutionEventData {
  resolutionRule: 'match_or_signal_v2';
  predictionId: string;
  responseMessageId: string;
  predictedSignal: SocialSignal;
  observedSignal: SocialSignal;
  matched: boolean;
  reward: number;
}

export interface UtilityUpdateEventData {
  targetType: 'memory' | 'strategy' | 'prediction';
  targetId: string;
  contextKey: string;
  reward: number;
  alpha: number;
  previous: number;
  next: number;
  outcomeId: string;
}

export interface DreamSimulation {
  simulationId: string;
  title: string;
  premise: string;
  possibleUserMove: string;
  responseStance: string;
  uncertainty: string;
  confidence: number;
  sourceMemoryIds: string[];
}

export interface DreamSimulationEventData {
  cycleId: string;
  simulation: DreamSimulation;
}

export interface SelfDeltaCandidateEventData {
  cycleId: string;
  traitKey: string;
  op: 'add' | 'revise' | 'drop';
  note?: string;
  targetIndex?: number | null;
  confidence: number;
  reason: string;
}

export interface SelfDeltaDecisionEventData extends SelfDeltaCandidateEventData {
  candidateIds: string[];
  decision: 'accepted' | 'rejected' | 'deferred';
  uniqueEvidenceCount: number;
  uniqueCycleCount: number;
}

export interface PolicyCandidateEventData {
  policyId: string;
  parameter: string;
  currentValue: number;
  proposedValue: number;
  targetMetric: string;
  reason: string;
}

export interface PolicyDecisionEventData extends PolicyCandidateEventData {
  decision: 'promoted' | 'rejected' | 'deferred';
  baselineScore: number;
  candidateScore: number;
  regressions: string[];
}

export interface ShadowMemoryResultEventData {
  provider: string;
  operation: 'observe' | 'retrieve';
  latencyMs: number;
  accepted: boolean;
  itemIds: string[];
  detail: string;
  candidateCount?: number;
  jaccard?: number;
  rankAgreement?: number;
}

export interface UtilityProjection {
  targetType: UtilityUpdateEventData['targetType'];
  targetId: string;
  contextKey: string;
  value: number;
  updates: number;
  lastUpdatedAt: string;
}
