import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getDevelopmentStore } from './eventStore.js';
import type { ShadowMemoryResultEventData } from './types.js';

const log = logger('development:shadow');

export interface ShadowObservation {
  subjectId: string;
  channelId: string;
  memoryId: string;
  content: string;
  evidenceIds: string[];
}

export interface ShadowRetrieval {
  requestId: string;
  subjectId: string;
  channelId: string;
  query: string;
  /** Actual live top-k ids, supplied separately from the wider pre-utility candidate pool. */
  liveIds: string[];
  candidates: Array<{ id: string; kind: string; content: string; score: number }>;
  limit: number;
}

interface ShadowAdapterResult {
  accepted: boolean;
  itemIds: string[];
  detail: string;
  candidateCount?: number;
  jaccard?: number;
  rankAgreement?: number;
}

export interface ShadowMemoryAdapter {
  readonly name: string;
  observe(input: ShadowObservation): Promise<ShadowAdapterResult>;
  retrieve(input: ShadowRetrieval): Promise<ShadowAdapterResult>;
}

class LocalBaselineShadowAdapter implements ShadowMemoryAdapter {
  readonly name = 'local-baseline';

  async observe(input: ShadowObservation): Promise<ShadowAdapterResult> {
    const digest = crypto.createHash('sha256').update(input.content).digest('hex').slice(0, 20);
    return {
      accepted: true,
      itemIds: [`local-shadow:${digest}`],
      detail: 'local baseline observed the committed memory; no external service or duplicate live write',
    };
  }

  async retrieve(input: ShadowRetrieval): Promise<ShadowAdapterResult> {
    return {
      accepted: true,
      itemIds: input.liveIds.slice(0, input.limit),
      detail: 'local baseline mirrored the authoritative retrieval for comparison plumbing',
      candidateCount: input.candidates.length,
      jaccard: 1,
      rankAgreement: 1,
    };
  }
}

class LocalDiversityShadowAdapter implements ShadowMemoryAdapter {
  readonly name = 'local-diversity';

  async observe(input: ShadowObservation): Promise<ShadowAdapterResult> {
    const digest = crypto.createHash('sha256').update(input.content).digest('hex').slice(0, 20);
    return {
      accepted: true,
      itemIds: [`local-diversity:${digest}`],
      detail: 'local diversity shadow indexed committed content by digest without duplicating authoritative storage',
    };
  }

  async retrieve(input: ShadowRetrieval): Promise<ShadowAdapterResult> {
    const queryTerms = terms(input.query);
    const remaining = input.candidates.map((candidate, liveRank) => ({ candidate, liveRank }));
    const selected: typeof remaining = [];
    const kindCounts = new Map<string, number>();
    while (remaining.length && selected.length < input.limit) {
      remaining.sort((left, right) => {
        const leftScore = diversityScore(left.candidate, queryTerms, kindCounts);
        const rightScore = diversityScore(right.candidate, queryTerms, kindCounts);
        return rightScore - leftScore || left.candidate.id.localeCompare(right.candidate.id);
      });
      const next = remaining.shift()!;
      selected.push(next);
      kindCounts.set(next.candidate.kind, (kindCounts.get(next.candidate.kind) ?? 0) + 1);
    }
    const itemIds = selected.map(({ candidate }) => candidate.id);
    const liveIds = input.liveIds.slice(0, input.limit);
    const overlap = intersectionSize(new Set(liveIds), new Set(itemIds));
    const denominator = new Set([...liveIds, ...itemIds]).size;
    const rankAgreement = rankedAgreement(liveIds, itemIds);
    return {
      accepted: true,
      itemIds,
      detail: `local lexical/diversity rerank; live overlap=${overlap}/${denominator || 1} jaccard=${(overlap / Math.max(1, denominator)).toFixed(3)} rankAgreement=${rankAgreement.toFixed(3)}`,
      candidateCount: input.candidates.length,
      jaccard: overlap / Math.max(1, denominator),
      rankAgreement,
    };
  }
}

const adapters = new Map<string, ShadowMemoryAdapter>([
  ['local-baseline', new LocalBaselineShadowAdapter()],
  ['local-diversity', new LocalDiversityShadowAdapter()],
]);

export function registerShadowMemoryAdapter(adapter: ShadowMemoryAdapter): void {
  adapters.set(adapter.name.toLowerCase(), adapter);
}

export async function observeShadowMemory(input: ShadowObservation): Promise<void> {
  if (!config.development.enabled) return;
  const provider = config.development.shadowProvider;
  if (!provider || provider === 'none' || provider === 'off') return;
  const adapter = adapters.get(provider);
  if (!adapter) {
    log.warn(`shadow provider ${provider} is not registered; live memory remains unchanged`);
    return;
  }

  const started = performance.now();
  try {
    const result = await adapter.observe(input);
    const data: ShadowMemoryResultEventData = {
      provider: adapter.name,
      operation: 'observe',
      latencyMs: Math.max(0, performance.now() - started),
      accepted: result.accepted,
      itemIds: result.itemIds.slice(0, 30),
      detail: result.detail.slice(0, 500),
    };
    await getDevelopmentStore().append<ShadowMemoryResultEventData>({
      kind: 'shadow_memory_result',
      subjectId: input.subjectId,
      channelId: input.channelId,
      evidenceIds: input.evidenceIds,
      dedupeKey: `shadow:${adapter.name}:observe:${input.memoryId}`,
      data,
    });
  } catch (error: any) {
    log.warn(`shadow provider ${adapter.name} failed`, error?.message ?? error);
    const data: ShadowMemoryResultEventData = {
      provider: adapter.name,
      operation: 'observe',
      latencyMs: Math.max(0, performance.now() - started),
      accepted: false,
      itemIds: [],
      detail: `adapter failed: ${String(error?.message ?? error).slice(0, 420)}`,
    };
    await getDevelopmentStore().append<ShadowMemoryResultEventData>({
      kind: 'shadow_memory_result',
      subjectId: input.subjectId,
      channelId: input.channelId,
      evidenceIds: input.evidenceIds,
      dedupeKey: `shadow:${adapter.name}:failure:${input.memoryId}`,
      data,
    });
  }
}

export async function observeShadowRetrieval(input: ShadowRetrieval): Promise<void> {
  if (!config.development.enabled || input.candidates.length === 0) return;
  const provider = config.development.shadowProvider;
  if (!provider || provider === 'none' || provider === 'off') return;
  const adapter = adapters.get(provider);
  if (!adapter) {
    log.warn(`shadow provider ${provider} is not registered; live retrieval remains unchanged`);
    return;
  }

  const started = performance.now();
  try {
    const result = await adapter.retrieve(input);
    await appendShadowResult({
      provider: adapter.name,
      operation: 'retrieve',
      latencyMs: Math.max(0, performance.now() - started),
      accepted: result.accepted,
      itemIds: result.itemIds,
      detail: result.detail,
      candidateCount: result.candidateCount,
      jaccard: result.jaccard,
      rankAgreement: result.rankAgreement,
      subjectId: input.subjectId,
      channelId: input.channelId,
      evidenceIds: [`discord-message:${input.requestId}`, ...input.candidates.map((item) => `memory:${item.id}`)],
      dedupeKey: `shadow:${adapter.name}:retrieve:${input.requestId}`,
    });
  } catch (error: any) {
    log.warn(`shadow retrieval ${adapter.name} failed`, error?.message ?? error);
    await appendShadowResult({
      provider: adapter.name,
      operation: 'retrieve',
      latencyMs: Math.max(0, performance.now() - started),
      accepted: false,
      itemIds: [],
      detail: `adapter failed: ${String(error?.message ?? error).slice(0, 420)}`,
      subjectId: input.subjectId,
      channelId: input.channelId,
      evidenceIds: [`discord-message:${input.requestId}`],
      dedupeKey: `shadow:${adapter.name}:retrieve-failure:${input.requestId}`,
    });
  }
}

async function appendShadowResult(args: ShadowMemoryResultEventData & {
  subjectId: string;
  channelId: string;
  evidenceIds: string[];
  dedupeKey: string;
}): Promise<void> {
  const { subjectId, channelId, evidenceIds, dedupeKey, ...data } = args;
  await getDevelopmentStore().append<ShadowMemoryResultEventData>({
    kind: 'shadow_memory_result',
    subjectId,
    channelId,
    evidenceIds,
    dedupeKey,
    data: {
      ...data,
      itemIds: data.itemIds.slice(0, 30),
      detail: data.detail.slice(0, 500),
    },
  });
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_'-]{3,}/g) ?? []);
}

function diversityScore(
  candidate: ShadowRetrieval['candidates'][number],
  queryTerms: Set<string>,
  kindCounts: Map<string, number>,
): number {
  const contentTerms = terms(candidate.content);
  const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length / Math.max(1, queryTerms.size);
  const kindPenalty = (kindCounts.get(candidate.kind) ?? 0) * 0.12;
  return overlap - kindPenalty;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

export function rankedAgreement(liveIds: string[], shadowIds: string[]): number {
  if (liveIds.length === 0 && shadowIds.length === 0) return 1;
  const size = Math.max(liveIds.length, shadowIds.length, 1);
  const shadowPositions = new Map(shadowIds.map((id, index) => [id, index]));
  const displacement = liveIds.reduce(
    (sum, id, liveIndex) => sum + Math.abs(liveIndex - (shadowPositions.get(id) ?? size)),
    0,
  );
  return Math.max(0, Math.min(1, 1 - displacement / (size * size)));
}
