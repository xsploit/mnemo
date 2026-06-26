/**
 * Four layers, loosely mapping the human memory hierarchy:
 *
 *  episodic   raw observations as they happen ("the memory stream")
 *  semantic   consolidated facts about a person/world, with validity windows
 *  reflection higher-level insights synthesized from many memories
 *  diary      first-person narrative the bot writes while it sleeps (a "dream")
 */
export type MemoryKind = 'episodic' | 'semantic' | 'reflection' | 'diary';

export interface MemoryRecord {
  id: string;
  /** Scope key: usually a Discord user id, or `channel:<id>` for shared memory. */
  subjectId: string;
  kind: MemoryKind;
  content: string;
  embedding: number[] | null;
  /** Generative-Agents importance, 1–10, scored at write time. */
  importance: number;
  createdAt: Date;
  lastAccessedAt: Date;
  /** Temporal validity (Zep-style). validTo === null means "currently true". */
  validFrom: Date;
  validTo: Date | null;
  /** If this record replaced an older one, the id it superseded. */
  supersedes: string | null;
  /** The reasoning trace that produced/justified this memory — thoughts on thoughts. */
  reasoning: string | null;
  /** Source memory ids that fed a reflection or diary entry. */
  sources: string[];
  meta: Record<string, unknown>;
}

export interface ScoredMemory extends MemoryRecord {
  score: number;
  parts: { relevance: number; importance: number; recency: number };
}

export interface NewMemory {
  subjectId: string;
  kind: MemoryKind;
  content: string;
  importance?: number;
  embedding?: number[] | null;
  validFrom?: Date;
  validTo?: Date | null;
  supersedes?: string | null;
  reasoning?: string | null;
  sources?: string[];
  meta?: Record<string, unknown>;
}

export interface RetrieveOptions {
  subjectId: string;
  queryEmbedding: number[];
  kinds?: MemoryKind[];
  limit?: number;
  /** Only return memories currently valid (validTo is null or in the future). */
  validOnly?: boolean;
}

export interface MemoryStore {
  ready(): Promise<void>;
  insert(m: NewMemory): Promise<MemoryRecord>;
  retrieve(opts: RetrieveOptions): Promise<ScoredMemory[]>;
  /** Raw fetch for user-facing export/privacy tooling. */
  listSubject(subjectId: string): Promise<MemoryRecord[]>;
  /** Raw fetch for the worker: recent records of a kind for a subject. */
  recent(subjectId: string, kinds: MemoryKind[], since: Date, limit: number): Promise<MemoryRecord[]>;
  /** Mark records consumed by reflection/consolidation so they aren't re-processed. */
  markProcessed(ids: string[]): Promise<void>;
  /** Close a memory's validity window (soft delete / superseded). */
  expire(id: string, at: Date): Promise<void>;
  touch(ids: string[], at: Date): Promise<void>;
  /** Hard prune: low-importance, fully-decayed, expired memories. */
  prune(subjectId: string, before: Date, importanceBelow: number): Promise<number>;
  stats(subjectId: string): Promise<Record<MemoryKind, number>>;
}
