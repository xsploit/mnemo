import { config } from '../config.js';
import { logger } from '../logger.js';
import { FileMemoryStore } from './store-file.js';
import type { MemoryStore } from './types.js';

const log = logger('store');
let singleton: MemoryStore | null = null;

/**
 * Returns the active memory store. Uses Postgres+pgvector when DATABASE_URL is
 * set, otherwise the zero-infra file-backed store (ideal for running on a PC).
 */
export async function getStore(): Promise<MemoryStore> {
  if (singleton) return singleton;

  if (config.db.url) {
    const { PostgresMemoryStore } = await import('./store-postgres.js');
    const store = new PostgresMemoryStore(config.db.url);
    await store.ready();
    log.info('using Postgres + pgvector');
    singleton = store;
  } else {
    const store = new FileMemoryStore();
    await store.ready();
    log.info('using file-backed store (set DATABASE_URL for Postgres)');
    singleton = store;
  }
  return singleton;
}
