import { EmbedBuilder } from 'discord.js';
import { startBot } from './bot/client.js';
import { startDreamLoop } from './worker/scheduler.js';
import { lastChannelFor } from './worker/activity.js';
import type { DreamReport } from './worker/dreamer.js';
import { getStore } from './memory/store.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { acquireRuntimeLock } from './runtimeLock.js';
import type { Client } from 'discord.js';

const log = logger('main');
let releaseRuntimeLock: (() => Promise<void>) | null = null;

// Per-subject cooldown so dream announcements feel like a rare, real moment
// ("wait, it thought about me while I was gone?") instead of scheduled spam.
const lastAnnouncedAt = new Map<string, number>();

function dreamIsSalient(report: DreamReport): boolean {
  if (!report.diaryEntry) return false;
  return report.insights > 0 || report.factsAdded > 0 || report.simulations > 0 || report.selfEvolution.length > 0;
}

async function announceDream(client: Client, report: DreamReport): Promise<void> {
  if (!config.dream.announce || !dreamIsSalient(report)) return;

  const cooldownMs = config.dream.announceCooldownHours * 3_600_000;
  const last = lastAnnouncedAt.get(report.subjectId) ?? 0;
  if (Date.now() - last < cooldownMs) return;

  const channelId = lastChannelFor(report.subjectId);
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    const diary = report.diaryEntry!.length > 350 ? `${report.diaryEntry!.slice(0, 350).trimEnd()}…` : report.diaryEntry!;
    const consolidated = [
      report.factsAdded ? `learned **${report.factsAdded}** new thing${report.factsAdded === 1 ? '' : 's'}` : '',
      report.factsUpdated ? `updated **${report.factsUpdated}**` : '',
      report.insights ? `had **${report.insights}** realization${report.insights === 1 ? '' : 's'}` : '',
      report.simulations ? `rehearsed **${report.simulations}** possibilit${report.simulations === 1 ? 'y' : 'ies'}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const embed = new EmbedBuilder()
      .setColor(0x9b7bd8)
      .setTitle(`💤 ${config.bot.name} dreamed about you`)
      .setDescription(`*${diary}*`)
      .setFooter({ text: 'from her sleep cycle — memories consolidated while the channel was quiet' })
      .setTimestamp();
    if (consolidated) embed.addFields({ name: 'while she slept', value: consolidated });
    if (report.selfEvolution.length) {
      embed.addFields({ name: 'how she changed', value: report.selfEvolution.slice(0, 3).join('\n').slice(0, 1024) });
    }
    if (report.simulationPreview) {
      embed.addFields({
        name: 'a possibility she wondered about',
        value: report.simulationPreview.slice(0, 1024),
      });
    }
    if (report.policyCandidate) {
      embed.addFields({ name: 'memory lab candidate', value: report.policyCandidate.slice(0, 1024) });
    }

    await channel.send({
      content: `<@${report.subjectId}> crossed my mind while I was asleep…`,
      embeds: [embed],
      allowedMentions: { users: [report.subjectId] },
    });
    lastAnnouncedAt.set(report.subjectId, Date.now());
    log.info(`announced dream for ${report.subjectId} in #${channelId}`);
  } catch (e: any) {
    log.warn('dream announce failed', e?.message ?? e);
  }
}

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
    void announceDream(client, report);
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
