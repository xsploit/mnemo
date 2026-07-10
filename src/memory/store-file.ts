import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '../logger.js';
import { rankMemories } from './retrieval.js';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  NewMemory,
  RetrieveOptions,
  ScoredMemory,
} from './types.js';

const log = logger('store:file');

/**
 * Zero-infra memory store: holds everything in memory and persists to a JSON
 * file on disk. Perfect for running the bot on a single PC — survives restarts,
 * needs no database. Vector search is a brute-force cosine scan, which is fine
 * up to tens of thousands of memories.
 */
export class FileMemoryStore implements MemoryStore {
  private rows = new Map<string, MemoryRecord>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly path = 'data/memories.json') {}

  async ready(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as MemoryRecord[];
      for (const r of parsed) {
        this.rows.set(r.id, {
          ...r,
          createdAt: new Date(r.createdAt),
          lastAccessedAt: new Date(r.lastAccessedAt),
          validFrom: new Date(r.validFrom),
          validTo: r.validTo ? new Date(r.validTo) : null,
        });
      }
      log.info(`loaded ${this.rows.size} memories from ${this.path}`);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') log.warn(`could not load ${this.path}`, e?.message);
      else log.info(`no existing store at ${this.path}; starting fresh`);
    }
    // Periodic flush so a crash loses at most a few seconds of memory.
    this.flushTimer = setInterval(() => void this.flush(), 5_000);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      // Atomic write: a crash/kill mid-write can only ever leave the .tmp file
      // corrupt, never the real store — this is the sole source of truth for
      // every memory Hikari has, flushed every 5s while active.
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.rows.values()], null, 0));
      await rename(tmp, this.path);
    } catch (e: any) {
      log.error('flush failed', e?.message);
      this.dirty = true;
    }
  }

  async insert(m: NewMemory): Promise<MemoryRecord> {
    const now = new Date();
    const rec: MemoryRecord = {
      id: randomUUID(),
      subjectId: m.subjectId,
      kind: m.kind,
      content: m.content,
      embedding: m.embedding ?? null,
      importance: m.importance ?? 5,
      createdAt: now,
      lastAccessedAt: now,
      validFrom: m.validFrom ?? now,
      validTo: m.validTo ?? null,
      supersedes: m.supersedes ?? null,
      reasoning: m.reasoning ?? null,
      sources: m.sources ?? [],
      meta: m.meta ?? {},
    };
    this.rows.set(rec.id, rec);
    this.dirty = true;
    return rec;
  }

  async retrieve(opts: RetrieveOptions): Promise<ScoredMemory[]> {
    const now = new Date();
    const kinds = opts.kinds;
    const candidates = [...this.rows.values()].filter((r) => {
      if (r.subjectId !== opts.subjectId) return false;
      if (kinds && !kinds.includes(r.kind)) return false;
      if (opts.validOnly && r.validTo && r.validTo <= now) return false;
      return true;
    });
    const ranked = rankMemories(candidates, opts.queryEmbedding, now, opts.limit ?? 8);
    await this.touch(ranked.map((r) => r.id), now);
    return ranked;
  }

  async listSubject(subjectId: string): Promise<MemoryRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.subjectId === subjectId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async recent(subjectId: string, kinds: MemoryKind[], since: Date, limit: number): Promise<MemoryRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.subjectId === subjectId &&
          kinds.includes(r.kind) &&
          r.createdAt >= since &&
          r.meta['processed'] !== true,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async markProcessed(ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r) r.meta = { ...r.meta, processed: true };
    }
    this.dirty = true;
  }

  async expire(id: string, at: Date): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.validTo = at;
      this.dirty = true;
    }
  }

  async touch(ids: string[], at: Date): Promise<void> {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r) r.lastAccessedAt = at;
    }
    this.dirty = true;
  }

  async prune(subjectId: string, before: Date, importanceBelow: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.subjectId !== subjectId) continue;
      const expired = r.validTo !== null && r.validTo <= before;
      const faded = r.lastAccessedAt < before && r.importance < importanceBelow && r.kind === 'episodic';
      if (expired || faded) {
        this.rows.delete(id);
        n++;
      }
    }
    if (n) this.dirty = true;
    return n;
  }

  async stats(subjectId: string): Promise<Record<MemoryKind, number>> {
    const out: Record<MemoryKind, number> = { episodic: 0, semantic: 0, reflection: 0, diary: 0 };
    for (const r of this.rows.values()) if (r.subjectId === subjectId) out[r.kind]++;
    return out;
  }
}
