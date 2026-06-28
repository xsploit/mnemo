import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ScoredMemory } from '../memory/types.js';
import type { HistoryTurn } from './respond.js';
import type { PersonaAffect } from '../llm/personaOutput.js';

const TRACE_PATH = path.resolve('data', 'turn-traces.jsonl');

export interface ToolTraceEntry {
  phase: string;
  step: number;
  toolName: string;
  toolCallId?: string | null;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

export interface TurnTraceInput {
  subjectId: string;
  channelId: string;
  messageId: string;
  authorName: string;
  kind: string;
  prompt: string;
  answer: string;
  model: string;
  systemChars: number;
  promptChars: number;
  history: HistoryTurn[];
  retrieved: ScoredMemory[];
  affect?: PersonaAffect | null;
  toolTrace?: ToolTraceEntry[];
}

export interface TurnTraceRecord extends TurnTraceInput {
  id: string;
  timestamp: string;
}

export async function appendTurnTrace(input: TurnTraceInput): Promise<TurnTraceRecord> {
  const record: TurnTraceRecord = {
    ...input,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    prompt: clamp(input.prompt, 8000),
    answer: clamp(input.answer, 8000),
    history: input.history.map((item) => ({
      author: clamp(item.author, 200),
      content: clamp(item.content, 1200),
    })),
    retrieved: input.retrieved.map((item) => ({
      ...item,
      content: clamp(item.content, 1600),
      reasoning: item.reasoning ? clamp(item.reasoning, 1200) : null,
      embedding: null,
    })),
    toolTrace: (input.toolTrace ?? []).slice(0, 80).map((item) => ({
      phase: clamp(item.phase, 80),
      step: item.step,
      toolName: clamp(item.toolName, 160),
      toolCallId: item.toolCallId ? clamp(item.toolCallId, 240) : null,
      input: clampUnknown(item.input, 4000),
      output: clampUnknown(item.output, 12000),
      error: clampUnknown(item.error, 4000),
    })),
  };
  await fs.mkdir(path.dirname(TRACE_PATH), { recursive: true });
  await fs.appendFile(TRACE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function latestTurnTraceForChannel(channelId: string): Promise<TurnTraceRecord | null> {
  const traces = await readTurnTraces();
  for (let index = traces.length - 1; index >= 0; index--) {
    const trace = traces[index];
    if (trace?.channelId === channelId) return trace;
  }
  return null;
}

export async function searchTurnTraces(args: {
  query: string;
  subjectId?: string;
  channelId?: string;
  limit?: number;
  scanLimit?: number;
}): Promise<TurnTraceRecord[]> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const scanLimit = Math.min(Math.max(args.scanLimit ?? 300, limit), 2000);
  const terms = searchTerms(args.query);
  const traces = (await readTurnTraces())
    .filter((trace) => !args.subjectId || trace.subjectId === args.subjectId)
    .filter((trace) => !args.channelId || trace.channelId === args.channelId)
    .slice(-scanLimit);

  if (terms.length === 0) return traces.slice(-limit).reverse();

  return traces
    .map((trace) => ({ trace, score: traceSearchScore(trace, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || Date.parse(right.trace.timestamp) - Date.parse(left.trace.timestamp))
    .slice(0, limit)
    .map((item) => item.trace);
}

export async function readTurnTraces(): Promise<TurnTraceRecord[]> {
  try {
    const text = await fs.readFile(TRACE_PATH, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return isTrace(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function isTrace(value: unknown): value is TurnTraceRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { channelId?: unknown }).channelId === 'string');
}

function clamp(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 24))}\n[trace truncated]`;
}

function traceSearchScore(trace: TurnTraceRecord, terms: string[]): number {
  const haystack = [
    trace.authorName,
    trace.kind,
    trace.prompt,
    trace.answer,
    ...trace.history.flatMap((item) => [item.author, item.content]),
    ...trace.retrieved.map((item) => item.content),
    ...(trace.toolTrace ?? []).flatMap((item) => [
      item.phase,
      item.toolName,
      item.toolCallId ?? '',
      stringifyUnknown(item.input),
      stringifyUnknown(item.output),
      stringifyUnknown(item.error),
    ]),
  ]
    .join('\n')
    .toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function clampUnknown(value: unknown, maxChars: number): unknown {
  if (value === undefined || value === null) return value;
  const rendered = stringifyUnknown(value);
  if (rendered.length <= maxChars) {
    if (typeof value === 'string') return rendered;
    try {
      return JSON.parse(rendered);
    } catch {
      return rendered;
    }
  }
  return {
    truncated: true,
    chars: rendered.length,
    preview: clamp(rendered, maxChars),
  };
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(
        value,
        (_key, item) => {
          if (typeof item === 'bigint') return item.toString();
          if (item && typeof item === 'object') {
            if (seen.has(item)) return '[Circular]';
            seen.add(item);
          }
          return item;
        },
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
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
