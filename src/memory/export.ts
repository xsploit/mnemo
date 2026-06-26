import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryRecord, MemoryStore } from './types.js';

type MemoryExport = {
  schema: 'mnemo.memory-export.v1';
  subjectId: string;
  exportedAt: string;
  count: number;
  memories: MemoryRecord[];
};

export async function exportSubjectMemory(
  store: MemoryStore,
  subjectId: string,
  dir = 'data/exports',
): Promise<{ file: string; count: number }> {
  const memories = await store.listSubject(subjectId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `memory-${safeFileSegment(subjectId)}-${stamp}.json`);
  const payload: MemoryExport = {
    schema: 'mnemo.memory-export.v1',
    subjectId,
    exportedAt: new Date().toISOString(),
    count: memories.length,
    memories,
  };
  await writeFile(file, JSON.stringify(payload, null, 2));
  return { file, count: memories.length };
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'subject';
}
