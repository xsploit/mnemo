import { config } from '../config.js';

/**
 * The bot's character, fully driven by env (BOT_NAME / BOT_PERSONA / BOT_DREAM_VOICE).
 * Kept in one place so the chat voice, the reflective voice, and the dreaming
 * voice all stay the same person. Defaults to a neutral introspective persona —
 * set BOT_NAME and BOT_PERSONA to make it whoever you want.
 */
export const PERSONA = {
  name: config.bot.name,
  persona: config.bot.persona,
  /** Voice used by the dreaming worker when it writes a first-person diary entry. */
  dreamVoice: config.bot.dreamVoice,
} as const;
