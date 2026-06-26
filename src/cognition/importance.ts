import { z } from 'zod';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';

const schema = z.object({
  importance: z.number().min(1).max(10),
  why: z.string(),
});

/**
 * Generative-Agents "poignancy" score. The model rates how memorable an
 * observation is on a 1–10 scale (1 = mundane chatter, 10 = a core fact about
 * who someone is). This single number drives both retrieval ranking and what
 * survives forgetting.
 */
export async function scoreImportance(observation: string): Promise<{ importance: number; reasoning: string }> {
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
}
