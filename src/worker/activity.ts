/**
 * Tracks which subjects (users/channels) have had activity since the last dream,
 * and when they were last active. The scheduler uses last-activity to enforce the
 * "only dream while idle" gate, mirroring how sleep-time compute waits for the
 * system to be quiet before doing background work.
 */
const lastActive = new Map<string, number>();
const lastChannel = new Map<string, string>();
const dirty = new Set<string>();

export function noteActivity(subjectId: string, channelId?: string): void {
  lastActive.set(subjectId, Date.now());
  if (channelId) lastChannel.set(subjectId, channelId);
  dirty.add(subjectId);
}

/** Where this subject was last talking — used to deliver dream announcements. */
export function lastChannelFor(subjectId: string): string | null {
  return lastChannel.get(subjectId) ?? null;
}

export function idleMinutes(subjectId: string): number {
  const t = lastActive.get(subjectId);
  if (t === undefined) return Infinity;
  return (Date.now() - t) / 60_000;
}

/** Subjects with new activity that are now idle enough to process. */
export function dueForDreaming(idleThresholdMin: number): string[] {
  return [...dirty].filter((s) => idleMinutes(s) >= idleThresholdMin);
}

export function clearDirty(subjectId: string): void {
  dirty.delete(subjectId);
}
