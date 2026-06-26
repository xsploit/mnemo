import { runSleepCycle } from './dreamer.js';
import { logger } from '../logger.js';

const log = logger('run-once');

/**
 * Manually trigger one sleep cycle for a subject, e.g.:
 *   npm run dream -- <discord-user-id>
 */
async function main() {
  const subjectId = process.argv[2];
  if (!subjectId) {
    console.error('usage: npm run dream -- <subjectId>');
    process.exit(1);
  }
  const report = await runSleepCycle(subjectId, { lookbackHours: 168 });
  log.info('report', report);
  if (report.diaryEntry) console.log(`\n💤 Diary:\n${report.diaryEntry}\n`);
  process.exit(0);
}

main().catch((e) => {
  log.error('failed', e?.stack ?? e);
  process.exit(1);
});
