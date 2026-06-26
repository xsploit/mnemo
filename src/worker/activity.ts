/**
 * Tracks which subjects (users/channels) have had activity since the last dream,
 * and when they were last active. The scheduler uses last-activity to enforce the
 * "only dream while idle" gate, mirroring how sleep-time compute waits for the
 * system to be quiet before doing background work.
 */
const lastActive = new Map<string, number>();
const dirty = new Set<string>();

export function noteActivity(subjectId: string): void {
  lastActive.set(subjectId, Date.now());
  dirty.add(subjectId);
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
