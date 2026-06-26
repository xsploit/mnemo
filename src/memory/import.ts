import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { embedOne } from '../llm/embeddings.js';
import type { MemoryKind, MemoryStore, NewMemory } from './types.js';

const IMPORT_DIRS = ['data/imports', 'data/exports'] as const;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MEMORY_KINDS = new Set<MemoryKind>(['episodic', 'semantic', 'reflection', 'diary']);

type ImportCandidate = {
  sourceId: string;
  subjectId: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  embedding: number[] | null;
  validFrom?: Date | undefined;
  validTo?: Date | null | undefined;
  supersedes?: string | null | undefined;
  reasoning?: string | null | undefined;
  sources: string[];
  meta: Record<string, unknown>;
};

export type MemoryImportResult = {
  file: string;
  subjectId: string;
  scanned: number;
  imported: number;
  skipped: number;
};

export async function importSubjectMemory(
  store: MemoryStore,
  fileInput: string,
  subjectOverride?: string,
): Promise<MemoryImportResult> {
  const file = await resolveImportFile(fileInput);
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const candidates = parseImportCandidates(parsed, subjectOverride);
  const subjectId = subjectOverride ?? candidates[0]?.subjectId ?? 'unknown';
  const existing = await store.listSubject(subjectId);
  const existingKeys = new Set(existing.map((memory) => memoryImportKey(memory.kind, memory.content)));

  let imported = 0;
  let skipped = 0;
  for (const candidate of candidates.filter((item) => item.subjectId === subjectId)) {
    const key = memoryImportKey(candidate.kind, candidate.content);
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
    const memory: NewMemory = {
      subjectId,
      kind: candidate.kind,
      content: candidate.content,
      importance: candidate.importance,
      embedding: candidate.embedding ?? (await embedOne(candidate.content)),
      validFrom: candidate.validFrom,
      validTo: candidate.validTo,
      supersedes: candidate.supersedes,
      reasoning: candidate.reasoning ?? `Imported from ${basename(file)}.`,
      sources: candidate.sources,
      meta: {
        ...candidate.meta,
        importSource: basename(file),
        importSourceId: candidate.sourceId,
      },
    };
    await store.insert(memory);
    existingKeys.add(key);
    imported++;
  }

  return { file, subjectId, scanned: candidates.length, imported, skipped };
}

async function resolveImportFile(input: string): Promise<string> {
  const name = basename(input.trim());
  if (!name || name !== input.trim().replaceAll('\\', '/').split('/').pop()) {
    throw new Error('Import file must be a JSON filename under data/imports or data/exports.');
  }
  if (!name.toLowerCase().endsWith('.json')) {
    throw new Error('Import file must end in .json.');
  }
  for (const dir of IMPORT_DIRS) {
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > MAX_IMPORT_BYTES) {
        throw new Error(`Import file is too large: ${info.size} bytes > ${MAX_IMPORT_BYTES}.`);
      }
      return file;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Import file not found in ${IMPORT_DIRS.join(' or ')}: ${name}`);
}

function parseImportCandidates(value: unknown, subjectOverride?: string): ImportCandidate[] {
  if (Array.isArray(value)) return value.flatMap((item) => parseOneMemory(item, subjectOverride));
  if (isRecord(value) && Array.isArray(value.memories)) {
    const exportSubject = typeof value.subjectId === 'string' ? value.subjectId : undefined;
    return value.memories.flatMap((item) => parseOneMemory(item, subjectOverride ?? exportSubject));
  }
  throw new Error('Unsupported memory import JSON. Expected mnemo memory export or an array of memory records.');
}

function parseOneMemory(value: unknown, subjectOverride?: string): ImportCandidate[] {
  if (!isRecord(value)) return [];
  const kind = typeof value.kind === 'string' && MEMORY_KINDS.has(value.kind as MemoryKind) ? (value.kind as MemoryKind) : null;
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  const subjectId = subjectOverride ?? (typeof value.subjectId === 'string' ? value.subjectId : '');
  if (!kind || !content || !subjectId) return [];
  return [
    {
      sourceId: typeof value.id === 'string' ? value.id : memoryImportKey(kind, content),
      subjectId,
      kind,
      content,
      importance: clampImportance(value.importance),
      embedding: Array.isArray(value.embedding) && value.embedding.every((item) => typeof item === 'number') ? value.embedding : null,
      validFrom: parseDate(value.validFrom),
      validTo: value.validTo === null ? null : parseDate(value.validTo),
      supersedes: typeof value.supersedes === 'string' ? value.supersedes : null,
      reasoning: typeof value.reasoning === 'string' ? value.reasoning : null,
      sources: Array.isArray(value.sources) ? value.sources.filter((item): item is string => typeof item === 'string') : [],
      meta: isRecord(value.meta) ? value.meta : {},
    },
  ];
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function clampImportance(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(10, Math.max(1, Math.round(value))) : 5;
}

function memoryImportKey(kind: MemoryKind, content: string): string {
  return `${kind}:${content.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
