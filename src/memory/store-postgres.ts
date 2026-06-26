import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import pgvector from 'pgvector/pg';
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

const log = logger('store:pg');
const __dirname = dirname(fileURLToPath(import.meta.url));

/** pgvector returns either a parsed number[] (when its type codec is active) or the `[1,2,...]` text. */
function parseVector(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') {
    const inner = v.replace(/^\[|\]$/g, '').trim();
    return inner ? inner.split(',').map(Number) : [];
  }
  return null;
}

function rowToRecord(r: any): MemoryRecord {
  return {
    id: r.id,
    subjectId: r.subject_id,
    kind: r.kind,
    content: r.content,
    embedding: parseVector(r.embedding),
    importance: Number(r.importance),
    createdAt: new Date(r.created_at),
    lastAccessedAt: new Date(r.last_accessed),
    validFrom: new Date(r.valid_from),
    validTo: r.valid_to ? new Date(r.valid_to) : null,
    supersedes: r.supersedes ?? null,
    reasoning: r.reasoning ?? null,
    sources: r.sources ?? [],
    meta: r.meta ?? {},
  };
}

export class PostgresMemoryStore implements MemoryStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
    this.pool.on('connect', (client) => {
      // Register the pgvector type codec on every pooled connection.
      pgvector.registerType(client).catch((e) => log.warn('registerType failed', e?.message));
    });
  }

  async ready(): Promise<void> {
    const schema = await readFile(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await this.pool.query(schema);
    log.info('schema ensured');
  }

  async insert(m: NewMemory): Promise<MemoryRecord> {
    const emb = m.embedding ? pgvector.toSql(m.embedding) : null;
    const { rows } = await this.pool.query(
      `INSERT INTO memories
         (subject_id, kind, content, embedding, importance, valid_from, valid_to, supersedes, reasoning, sources, meta)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, now()),$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        m.subjectId,
        m.kind,
        m.content,
        emb,
        m.importance ?? 5,
        m.validFrom ?? null,
        m.validTo ?? null,
        m.supersedes ?? null,
        m.reasoning ?? null,
        m.sources ?? [],
        m.meta ?? {},
      ],
    );
    return rowToRecord(rows[0]);
  }

  async retrieve(opts: RetrieveOptions): Promise<ScoredMemory[]> {
    const now = new Date();
    const limit = opts.limit ?? 8;
    // Pull a generous ANN candidate set by cosine distance, then apply the full
    // recency·importance·relevance scoring in JS so the weights stay tunable.
    const params: any[] = [opts.subjectId, pgvector.toSql(opts.queryEmbedding)];
    let where = 'subject_id = $1 AND embedding IS NOT NULL';
    if (opts.kinds?.length) {
      params.push(opts.kinds);
      where += ` AND kind = ANY($${params.length})`;
    }
    if (opts.validOnly) where += ' AND (valid_to IS NULL OR valid_to > now())';

    const { rows } = await this.pool.query(
      `SELECT * FROM memories
       WHERE ${where}
       ORDER BY embedding <=> $2
       LIMIT ${Math.max(limit * 4, 32)}`,
      params,
    );
    const ranked = rankMemories(rows.map(rowToRecord), opts.queryEmbedding, now, limit);
    await this.touch(ranked.map((r) => r.id), now);
    return ranked;
  }

  async listSubject(subjectId: string): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memories WHERE subject_id = $1 ORDER BY created_at ASC`,
      [subjectId],
    );
    return rows.map(rowToRecord);
  }

  async recent(subjectId: string, kinds: MemoryKind[], since: Date, limit: number): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM memories
       WHERE subject_id = $1 AND kind = ANY($2) AND created_at >= $3 AND processed = FALSE
       ORDER BY created_at ASC
       LIMIT $4`,
      [subjectId, kinds, since, limit],
    );
    return rows.map(rowToRecord);
  }

  async markProcessed(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(`UPDATE memories SET processed = TRUE WHERE id = ANY($1)`, [ids]);
  }

  async expire(id: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE memories SET valid_to = $2 WHERE id = $1`, [id, at]);
  }

  async touch(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(`UPDATE memories SET last_accessed = $2 WHERE id = ANY($1)`, [ids, at]);
  }

  async prune(subjectId: string, before: Date, importanceBelow: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM memories
       WHERE subject_id = $1
         AND (
           (valid_to IS NOT NULL AND valid_to <= $2)
           OR (kind = 'episodic' AND last_accessed < $2 AND importance < $3)
         )`,
      [subjectId, before, importanceBelow],
    );
    return rowCount ?? 0;
  }

  async stats(subjectId: string): Promise<Record<MemoryKind, number>> {
    const { rows } = await this.pool.query(
      `SELECT kind, COUNT(*)::int AS n FROM memories WHERE subject_id = $1 GROUP BY kind`,
      [subjectId],
    );
    const out: Record<MemoryKind, number> = { episodic: 0, semantic: 0, reflection: 0, diary: 0 };
    for (const r of rows) out[r.kind as MemoryKind] = r.n;
    return out;
  }
}
