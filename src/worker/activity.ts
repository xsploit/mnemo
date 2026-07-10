/**
 * Tracks which subjects (users/channels) have had activity since the last dream,
 * and when they were last active. The scheduler uses last-activity to enforce the
 * "only dream while idle" gate, mirroring how sleep-time compute waits for the
 * system to be quiet before doing background work.
 */
const lastActive = new Map<string, number>();
const lastChannel = new Map<string, string>();
const dirty = new Set<string>();
const versions = new Map<string, number>();

export function noteActivity(subjectId: string, channelId?: string): void {
  lastActive.set(subjectId, Date.now());
  if (channelId) lastChannel.set(subjectId, channelId);
  dirty.add(subjectId);
  versions.set(subjectId, (versions.get(subjectId) ?? 0) + 1);
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

export function activityVersion(subjectId: string): number {
  return versions.get(subjectId) ?? 0;
}

/** Clear only activity already included in a cycle; preserve newer messages. */
export function clearDirty(subjectId: string, throughVersion = activityVersion(subjectId)): boolean {
  if (activityVersion(subjectId) > throughVersion) return false;
  dirty.delete(subjectId);
  return true;
}
