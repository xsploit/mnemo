import { config } from '../config.js';
import { getStore } from '../memory/store.js';
import { logger } from '../logger.js';

const log = logger('db:init');

/** Ensures the schema exists (Postgres) or the data dir is ready (file store). */
async function main() {
  await getStore();
  log.info(config.db.url ? 'Postgres schema ensured.' : 'File store ready (no DATABASE_URL set).');
  process.exit(0);
}

main().catch((e) => {
  log.error('init failed', e?.stack ?? e);
  process.exit(1);
});
