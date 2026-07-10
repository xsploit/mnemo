import { config } from '../config.js';
import { logger } from '../logger.js';
import { runSleepCycle, type DreamReport } from './dreamer.js';
import { activityVersion, clearDirty, dueForDreaming } from './activity.js';

const log = logger('scheduler');

type OnDream = (report: DreamReport) => void;

/**
 * Drives the dreaming worker on an interval. Every tick it asks which subjects
 * have new activity *and* have gone quiet (the idle gate), then runs a sleep
 * cycle for each. The work happens off the conversation's critical path — the
 * bot stays responsive while it "sleeps on it."
 *
 * If REDIS_URL is set, the same runSleepCycle could be enqueued on BullMQ for a
 * durable, multi-process worker; the in-process interval below is the default so
 * the bot runs as a single PC process with no extra services.
 */
export function startDreamLoop(onDream?: OnDream): () => void {
  const intervalMs = Math.max(config.dream.intervalMin, 1) * 60_000;
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap cycles
    running = true;
    try {
      const due = dueForDreaming(config.dream.idleMin);
      if (due.length) log.info(`dreaming for ${due.length} subject(s): ${due.join(', ')}`);
      for (const subjectId of due) {
        try {
          const throughVersion = activityVersion(subjectId);
          const report = await runSleepCycle(subjectId);
          clearDirty(subjectId, throughVersion);
          if (report.observations > 0) onDream?.(report);
        } catch (e: any) {
          log.error(`sleep cycle failed for ${subjectId}`, e?.message);
        }
      }
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();
  log.info(`dream loop every ${config.dream.intervalMin}m, idle gate ${config.dream.idleMin}m`);
  return () => clearInterval(handle);
}
