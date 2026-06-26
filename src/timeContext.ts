const BC_PDT_OFFSET_MINUTES = -7 * 60;
const BC_PDT_TIME_ZONE = 'UTC-07:00';

export interface PacificTimeSnapshot {
  timeZone: 'UTC-07:00';
  label: 'BC PDT';
  pacificNow: string;
  pacificDate: string;
  utcIso: string;
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
