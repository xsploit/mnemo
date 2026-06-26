import { startBot } from './bot/client.js';
import { startDreamLoop } from './worker/scheduler.js';
import { getStore } from './memory/store.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { acquireRuntimeLock } from './runtimeLock.js';

const log = logger('main');
let releaseRuntimeLock: (() => Promise<void>) | null = null;

/**
 * Entry point: one process running two minds.
 *  - the bot (foreground): talks, remembers, lays down observations
 *  - the dreamer (background loop): sleeps on idle subjects and rewrites memory
 */
async function main() {
  releaseRuntimeLock = await acquireRuntimeLock();
  await getStore(); // initialize the memory store up front (fail fast)
  const client = await startBot();

  const stopDreaming = startDreamLoop((report) => {
    if (report.diaryEntry) {
      log.info(`💤 dreamed for ${report.subjectId}: "${report.diaryEntry.slice(0, 80)}…"`);
    }
  });

  const shutdown = async (sig: string) => {
    log.info(`${sig} received, shutting down`);
    stopDreaming();
    await client.destroy();
    await releaseRuntimeLock?.();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info(`${config.bot.name} is awake.`);
}

main().catch((e) => {
  log.error('fatal', e?.stack ?? e);
  void (async () => {
    await releaseRuntimeLock?.();
    process.exit(1);
  })();
});
