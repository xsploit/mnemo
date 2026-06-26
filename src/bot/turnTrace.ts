import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ScoredMemory } from '../memory/types.js';
import type { HistoryTurn } from './respond.js';
import type { PersonaAffect } from '../llm/personaOutput.js';

const TRACE_PATH = path.resolve('data', 'turn-traces.jsonl');

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
  };
  await fs.mkdir(path.dirname(TRACE_PATH), { recursive: true });
  await fs.appendFile(TRACE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export async function latestTurnTraceForChannel(channelId: string): Promise<TurnTraceRecord | null> {
  const traces = await readTraces();
  for (let index = traces.length - 1; index >= 0; index--) {
    const trace = traces[index];
    if (trace?.channelId === channelId) return trace;
  }
  return null;
}

async function readTraces(): Promise<TurnTraceRecord[]> {
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
