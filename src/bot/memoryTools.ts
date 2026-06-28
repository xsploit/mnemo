import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { embedOne } from '../llm/embeddings.js';
import { getStore } from '../memory/store.js';
import { scoreMemory } from '../memory/retrieval.js';
import type { MemoryKind, MemoryRecord, ScoredMemory } from '../memory/types.js';
import { searchTurnTraces, type TurnTraceRecord } from './turnTrace.js';

const memoryKindSchema = z.enum(['episodic', 'semantic', 'reflection', 'diary']);
const historyScopeSchema = z.enum(['user', 'channel', 'both']);

export interface MemoryToolScope {
  subjectId: string;
  channelId: string;
  userName: string;
  memoryEnabled: boolean;
}

export function createMemorySearchTools(scope: MemoryToolScope): ToolSet {
  if (!scope.memoryEnabled) return {};

  return {
    memory_search: tool({
      description:
        'Read-only. Search long-term memory for the current user. Use before saying you cannot remember something.',
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        kinds: z.array(memoryKindSchema).optional(),
        limit: z.number().int().min(1).max(20).default(10),
        lookback_hours: z.number().min(1).max(24 * 365).optional(),
      }),
      execute: async ({ query, kinds, limit, lookback_hours }) => {
        const store = await getStore();
        const queryEmbedding = await embedOne(query);
        const now = new Date();
        const cutoff = lookback_hours ? new Date(now.getTime() - lookback_hours * 3_600_000) : null;
        const [vectorHits, allRows] = await Promise.all([
          store.retrieve({
            subjectId: scope.subjectId,
            queryEmbedding,
            kinds: kinds as MemoryKind[] | undefined,
            limit: Math.min(limit * 2, 40),
            validOnly: true,
          }),
          store.listSubject(scope.subjectId),
        ]);

        const terms = searchTerms(query);
        const lexicalHits = allRows
          .filter((row) => !row.validTo || row.validTo > now)
          .filter((row) => !kinds?.length || (kinds as MemoryKind[]).includes(row.kind))
          .filter((row) => !cutoff || row.createdAt >= cutoff)
          .map((row) => ({ row, lexical: lexicalScore(row.content, terms) }))
          .filter((item) => item.lexical > 0)
          .sort((left, right) => right.lexical - left.lexical || right.row.createdAt.getTime() - left.row.createdAt.getTime())
          .slice(0, Math.min(limit * 2, 40))
          .map((item) => scoreMemory(item.row, queryEmbedding, now));

        const results = mergeScored([...vectorHits, ...lexicalHits])
          .filter((row) => !cutoff || row.createdAt >= cutoff)
          .slice(0, limit)
          .map(formatMemoryHit);

        return {
          source: 'long_term_memory',
          user: { id: scope.subjectId, name: scope.userName },
          query,
          count: results.length,
          results,
        };
      },
    }),
    history_search: tool({
      description:
        'Read-only. Search saved bot turn history: prior user prompts, bot replies, packed channel context, and retrieved memories.',
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        scope: historyScopeSchema.default('both'),
        limit: z.number().int().min(1).max(20).default(10),
        scan_limit: z.number().int().min(20).max(2000).default(500),
      }),
      execute: async ({ query, scope: searchScope, limit, scan_limit }) => {
        const traces = await searchTurnTraces({
          query,
          subjectId: searchScope === 'channel' ? undefined : scope.subjectId,
          channelId: searchScope === 'user' ? undefined : scope.channelId,
          limit,
          scanLimit: scan_limit,
        });
        return {
          source: 'turn_history',
          query,
          scope: searchScope,
          count: traces.length,
          results: traces.map(formatTraceHit),
        };
      },
    }),
  };
}

function formatMemoryHit(memory: ScoredMemory): Record<string, unknown> {
  return {
    id: memory.id,
    kind: memory.kind,
    createdAt: memory.createdAt.toISOString(),
    validTo: memory.validTo?.toISOString() ?? null,
    importance: memory.importance,
    score: Number(memory.score.toFixed(4)),
    content: clamp(memory.content, 1200),
    sources: memory.sources.slice(0, 8),
  };
}

function formatTraceHit(trace: TurnTraceRecord): Record<string, unknown> {
  return {
    id: trace.id,
    timestamp: trace.timestamp,
    channelId: trace.channelId,
    messageId: trace.messageId,
    authorName: trace.authorName,
    kind: trace.kind,
    prompt: clamp(trace.prompt, 1000),
    answer: clamp(trace.answer, 1000),
    history: trace.history.slice(-8).map((item) => ({
      author: clamp(item.author, 120),
      content: clamp(item.content, 500),
    })),
    retrieved: trace.retrieved.slice(0, 8).map((item) => ({
      id: item.id,
      kind: item.kind,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt),
      content: clamp(item.content, 500),
    })),
  };
}

function mergeScored(memories: ScoredMemory[]): ScoredMemory[] {
  const byId = new Map<string, ScoredMemory>();
  for (const memory of memories) {
    const existing = byId.get(memory.id);
    if (!existing || memory.score > existing.score) byId.set(memory.id, memory);
  }
  return [...byId.values()].sort((left, right) => right.score - left.score || right.createdAt.getTime() - left.createdAt.getTime());
}

function lexicalScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function searchTerms(query: string): string[] {
  const stop = new Set([
    'about',
    'again',
    'did',
    'does',
    'for',
    'have',
    'last',
    'memory',
    'remember',
    'recall',
    'search',
    'that',
    'the',
    'this',
    'what',
    'when',
    'were',
    'with',
    'you',
  ]);
  return [...new Set(query.toLowerCase().match(/[a-z0-9_'-]{3,}/g) ?? [])].filter((term) => !stop.has(term));
}

function clamp(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 24))} [truncated]`;
}
