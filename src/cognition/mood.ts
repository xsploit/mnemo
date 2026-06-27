import { ActivityType, type Client, type PresenceData } from 'discord.js';
import type { PersonaAffect } from '../llm/personaOutput.js';

/**
 * Emotional continuity. Each turn produces an affect object; we keep the last
 * one per subject so the next reply can carry mood momentum instead of resetting
 * to neutral, and we keep the most recent affect globally to drive Discord presence.
 */
const lastBySubject = new Map<string, PersonaAffect>();
let latest: PersonaAffect | null = null;
let lastPresenceAt = 0;

export function recordMood(subjectId: string, affect: PersonaAffect | null): void {
  if (!affect) return;
  lastBySubject.set(subjectId, affect);
  latest = affect;
}

export function getMomentum(subjectId: string): PersonaAffect | null {
  return lastBySubject.get(subjectId) ?? null;
}

export function getLatestMood(): PersonaAffect | null {
  return latest;
}

/** A short line fed into the next system prompt so mood has inertia. */
export function momentumLine(affect: PersonaAffect | null): string {
  if (!affect) return '';
  const bits: string[] = [];
  if (affect.mood) bits.push(`mood "${affect.mood}"`);
  if (affect.valence !== undefined) bits.push(`valence ${affect.valence.toFixed(2)}`);
  if (affect.arousal !== undefined) bits.push(`energy ${affect.arousal.toFixed(2)}`);
  if (!bits.length) return '';
  return `Coming into this moment you were already feeling: ${bits.join(', ')}. Let that carry with natural drift — don't snap back to neutral, and don't over-explain the mood.`;
}

const MOOD_EMOJI: Record<string, string> = {
  bubbly: '✨',
  hyper: '⚡',
  sweet: '🍓',
  smug: '😏',
  delulu: '🌀',
  obsessed: '💖',
  unbothered: '💅',
  'menacing-but-cute': '😈',
  bored: '🥱',
  soft: '🫶',
  flustered: '😳',
  amused: '😆',
  dramatic: '🎭',
  reflective: '🌙',
};

function emojiFor(mood: string | undefined): string {
  if (!mood) return '💭';
  return MOOD_EMOJI[mood.toLowerCase()] ?? '💭';
}

/** Map affect to a Discord custom status. Throttled to avoid presence rate limits. */
export function applyMoodPresence(client: Client, minIntervalMs = 15_000): void {
  if (!client.user || !latest) return;
  const now = Date.now();
  if (now - lastPresenceAt < minIntervalMs) return;
  lastPresenceAt = now;

  const mood = latest.mood ?? 'vibing';
  const valence = latest.valence ?? 0;
  const arousal = latest.arousal ?? 0.5;

  const status: PresenceData['status'] =
    valence <= -0.5 ? 'dnd' : arousal < 0.25 ? 'idle' : 'online';

  client.user.setPresence({
    status,
    activities: [{ type: ActivityType.Custom, name: 'mood', state: `${emojiFor(mood)} ${mood}` }],
  });
}
