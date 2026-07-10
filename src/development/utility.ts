import { config } from '../config.js';
import type { ScoredMemory } from '../memory/types.js';
import { getDevelopmentStore, utilityKey } from './eventStore.js';
import type { UtilityUpdateEventData } from './types.js';
import type { UtilityProjection } from './types.js';
import { getEffectiveDevelopmentPolicy } from './effectivePolicy.js';

export async function rerankMemoriesWithUtility(
  memories: ScoredMemory[],
  contextKey = 'global',
  subjectId?: string,
): Promise<ScoredMemory[]> {
  if (!config.development.enabled || memories.length === 0) return memories;
  const [projection, policy] = await Promise.all([
    getDevelopmentStore().utilityProjection(),
    getEffectiveDevelopmentPolicy(getDevelopmentStore(), subjectId),
  ]);
  return applyUtilityToMemories(
    memories,
    projection,
    contextKey,
    policy.utilityWeight,
    config.development.utilityMinRelevance,
  );
}

export function applyUtilityToMemories(
  memories: ScoredMemory[],
  projection: Map<string, UtilityProjection>,
  contextKey: string,
  weight: number,
  minRelevance: number,
): ScoredMemory[] {
  return memories
    .map((memory) => {
      if (memory.parts.relevance < minRelevance) return memory;
      const utility = projection.get(utilityKey('memory', memory.id, contextKey))?.value ?? 0;
      const multiplier = 1 + weight * utility;
      return {
        ...memory,
        score: Math.max(0, memory.score * multiplier),
        meta: { ...memory.meta, developmentUtility: utility, developmentUtilityMultiplier: multiplier },
      };
    })
    .sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime());
}

export function selectCreditEligibleMemoryIds(
  memories: ScoredMemory[],
  minRelevance: number,
  limit = 8,
): string[] {
  return [...memories]
    .filter((memory) => memory.parts.relevance >= minRelevance)
    .sort(
      (left, right) =>
        right.parts.relevance - left.parts.relevance ||
        right.score - left.score ||
        right.createdAt.getTime() - left.createdAt.getTime(),
    )
    .slice(0, Math.max(0, limit))
    .map((memory) => memory.id);
}

export async function recordUtilityUpdates(args: {
  targetType: UtilityUpdateEventData['targetType'];
  targetIds: string[];
  reward: number;
  outcomeId: string;
  subjectId?: string;
  channelId?: string;
  evidenceIds: string[];
  contextKey?: string;
}): Promise<void> {
  if (!config.development.enabled || args.targetIds.length === 0) return;
  const store = getDevelopmentStore();
  const contextKey = args.contextKey ?? 'global';
  const reward = clamp(args.reward, -1, 1);
  const alpha = config.development.utilityAlpha;
  const projection = await store.utilityProjection();

  for (const targetId of [...new Set(args.targetIds.filter(Boolean))]) {
    const key = utilityKey(args.targetType, targetId, contextKey);
    const previous = projection.get(key)?.value ?? 0;
    const next = clamp(previous + alpha * (reward - previous), -1, 1);
    const data: UtilityUpdateEventData = {
      targetType: args.targetType,
      targetId,
      contextKey,
      reward,
      alpha,
      previous,
      next,
      outcomeId: args.outcomeId,
    };
    const event = await store.append<UtilityUpdateEventData>({
      kind: 'utility_update',
      subjectId: args.subjectId,
      channelId: args.channelId,
      evidenceIds: args.evidenceIds,
      dedupeKey: `utility:${args.outcomeId}:${args.targetType}:${targetId}:${contextKey}`,
      data,
    });
    projection.set(key, {
      targetType: args.targetType,
      targetId,
      contextKey,
      value: next,
      updates: (projection.get(key)?.updates ?? 0) + 1,
      lastUpdatedAt: event.timestamp,
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}
