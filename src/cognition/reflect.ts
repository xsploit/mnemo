import { z } from 'zod';
import { config } from '../config.js';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';
import { embedOne } from '../llm/embeddings.js';
import { logger } from '../logger.js';
import type { MemoryRecord, MemoryStore } from '../memory/types.js';
import { PERSONA } from './persona.js';
import { renderXmlPersonaTemplate } from '../xmlPersona.js';

const log = logger('reflect');

/**
 * Generative-Agents reflection. Two stages:
 *   1. From recent memories, ask the salient high-level questions.
 *   2. Answer them as insights grounded in (and citing) those memories.
 *
 * Insights are stored as their own `reflection` records, which means later
 * reflections can build on earlier ones — thoughts on thoughts on thoughts.
 */
const reflectionSchema = z.object({
  questions: z.array(z.string()).max(3),
  insights: z.array(
    z.object({
      insight: z.string(),
      importance: z.number().min(1).max(10),
      basis: z.array(z.number()).describe('Indices of the memories that support this insight.'),
    }),
  ),
});

export async function reflect(
  store: MemoryStore,
  subjectId: string,
  memories: MemoryRecord[],
): Promise<{ created: MemoryRecord[]; reasoning: string }> {
  if (memories.length < 3) return { created: [], reasoning: 'too few memories to reflect on' };

  const numbered = memories.map((m, i) => `${i}. (${m.kind}) ${m.content}`).join('\n');
  const persona = renderXmlPersonaTemplate(PERSONA.persona, {
    bot_name: PERSONA.name,
    username: subjectId,
    user_name: subjectId,
    user_input: 'private reflection cycle',
    personality_mood: 'reflective',
    social_relationship_level: 'friendly',
    social_level: 'friendly',
  });

  const { object, reasoning } = await reasonedObject({
    model: models.json,
    schema: reflectionSchema,
    system: `${persona}

You are the reflective layer of ${config.bot.name}'s own memory. Given recent memories, first identify the few most salient questions ${config.bot.name} would privately ask about this person or the relationship, then answer each as a concise higher-level insight.

Voice contract:
- Insights should sound like ${config.bot.name}'s own reflective thought, not a sterile analyst report.
- Preserve the configured character voice while staying grounded in cited memory indices.
- Do not turn personality, humor, or playful phrasing into a failure by itself.
- Each insight must be supported by specific memories. Insights should change how ${config.bot.name} relates to someone, not restate raw facts.`,
    prompt: `Recent memories:\n${numbered}`,
    temperature: 0.5,
  });

  const created: MemoryRecord[] = [];
  for (const ins of object.insights) {
    const sources = ins.basis
      .map((i) => memories[i]?.id)
      .filter((x): x is string => Boolean(x));
    const rec = await store.insert({
      subjectId,
      kind: 'reflection',
      content: ins.insight,
      importance: ins.importance,
      embedding: await embedOne(ins.insight),
      reasoning,
      sources,
      meta: { questions: object.questions },
    });
    created.push(rec);
  }

  log.info(`subject=${subjectId} ${created.length} insights from ${memories.length} memories`);
  return { created, reasoning };
}
