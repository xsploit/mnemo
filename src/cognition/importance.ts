import { z } from 'zod';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';
import { logger } from '../logger.js';

const log = logger('importance');

const schema = z.object({
  importance: z.number().min(1).max(10),
  why: z.string(),
});

const IMPORTANCE_SIGNAL =
  /\b(never|always|hate|love|favou?rite|important|remember|promise|deadline|birthday|died|funeral|breakup|engaged|married|divorce|quit|fired|moving|diagnos|allergic|emergency|secret|don'?t forget)\b/i;

/**
 * Deterministic poignancy fallback used when the JSON model fails or returns an
 * off-schema response. Cheap, no LLM — so a turn's memory is never silently
 * dropped just because structured output hiccupped.
 */
export function heuristicImportance(text: string): number {
  const t = text.trim();
  if (!t) return 3;
  let score = 3;
  if (t.length > 80) score += 1;
  if (t.length > 240) score += 1;
  if (/[!?]/.test(t)) score += 1;
  if (/\b(i|i'?m|my|me|we|our|us)\b/i.test(t)) score += 1;
  if (IMPORTANCE_SIGNAL.test(t)) score += 2;
  return Math.min(10, Math.max(1, score));
}

/**
 * Generative-Agents "poignancy" score, 1–10. Prefers an LLM judgment but always
 * returns a value — on any model/schema failure it falls back to the heuristic
 * so the episodic memory still gets recorded.
 */
export async function scoreImportance(observation: string): Promise<{ importance: number; reasoning: string }> {
  try {
    const { object, reasoning } = await reasonedObject({
      model: models.json,
      schema,
      system:
        'You rate how poignant/memorable a single observation is for a long-term companion AI. ' +
        '1 = utterly mundane (greetings, filler). 5 = a normal preference or event. ' +
        '10 = a defining fact, a strong emotion, a turning point. Return only the number and a brief why.',
      prompt: `Observation: "${observation}"`,
      temperature: 0,
    });
    return { importance: object.importance, reasoning: reasoning || object.why };
  } catch (e: any) {
    const importance = heuristicImportance(observation);
    log.warn(`importance model failed, used heuristic (${importance}/10)`, e?.message);
    return { importance, reasoning: 'heuristic importance (model output was unavailable or off-schema)' };
  }
}
