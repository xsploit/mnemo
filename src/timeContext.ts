const BC_PDT_OFFSET_MINUTES = -7 * 60;
const BC_PDT_TIME_ZONE = 'UTC-07:00';

export interface PacificTimeSnapshot {
  timeZone: 'UTC-07:00';
  label: 'BC PDT';
  pacificNow: string;
  pacificDate: string;
  utcIso: string;
}

export interface DiscordMessageTimeContext {
  sentAtUtc: string;
  sentAtPdt: string;
  ageSeconds: number;
  ageHuman: string;
}

export function pacificTimeSnapshot(now = new Date()): PacificTimeSnapshot {
  const local = new Date(now.getTime() + BC_PDT_OFFSET_MINUTES * 60_000);
  return {
    timeZone: BC_PDT_TIME_ZONE,
    label: 'BC PDT',
    pacificNow: new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      dateStyle: 'full',
      timeStyle: 'medium',
    }).format(local) + ' PDT',
    pacificDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(local),
    utcIso: now.toISOString(),
  };
}

export function renderPacificTimeContext(now = new Date()): string {
  const snapshot = pacificTimeSnapshot(now);
  return [
    'CURRENT DATE AND TIME',
    `- ${snapshot.label} (fixed ${snapshot.timeZone}): ${snapshot.pacificNow}`,
    `- BC PDT date: ${snapshot.pacificDate}`,
    `- UTC: ${snapshot.utcIso}`,
    '- Use fixed BC PDT as the default anchor for today, tonight, yesterday, tomorrow, and recent/current searches unless the user specifies another timezone.',
  ].join('\n');
}

export function discordMessageTimeContext(sentAt: Date | string | number, now = new Date()): DiscordMessageTimeContext {
  const sent = sentAt instanceof Date ? sentAt : new Date(sentAt);
  const sentMs = sent.getTime();
  if (!Number.isFinite(sentMs)) throw new Error(`Invalid Discord message timestamp: ${String(sentAt)}`);
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - sentMs) / 1000));
  return {
    sentAtUtc: sent.toISOString(),
    sentAtPdt: formatPacificTimestamp(sent),
    ageSeconds,
    ageHuman: formatMessageAge(ageSeconds),
  };
}

export function formatMessageAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatPacificTimestamp(value: Date): string {
  const local = new Date(value.getTime() + BC_PDT_OFFSET_MINUTES * 60_000);
  return `${new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(local)} PDT`;
}
