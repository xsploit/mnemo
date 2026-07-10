import { config } from '../config.js';

/**
 * The one true "she broke" message: publicly begs someone to ping the owner,
 * with the actual error tucked into spoilered subtext for whoever's debugging.
 */
export function aiProblemMessage(error: unknown): string {
  const owner = config.bot.ownerUserIds[0];
  // Spoilers break on '|' and newlines make subtext escape — sanitize.
  const detail = String((error as any)?.message ?? error ?? 'unknown error')
    .replace(/\|/g, '¦')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  return `PLS somebody tell <@${owner}> there is a problem with my ai 😭\n-# ||${detail}||`;
}

/** Mention allowance so the owner ping actually pings (and nobody else). */
export function aiProblemMentions(): { users: string[]; repliedUser: boolean } {
  const owner = config.bot.ownerUserIds[0];
  return { users: owner ? [owner] : [], repliedUser: false };
}
