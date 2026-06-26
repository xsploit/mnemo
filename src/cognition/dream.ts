import { models } from '../llm/gateway.js';
import { reasonedText } from '../llm/reason.js';
import { embedOne } from '../llm/embeddings.js';
import { PERSONA } from './persona.js';
import { logger } from '../logger.js';
import type { MemoryRecord, MemoryStore } from '../memory/types.js';
import { renderXmlPersonaTemplate } from '../xmlPersona.js';
import { extractPersonaMessage } from '../llm/personaOutput.js';

const log = logger('dream');

/**
 * The dream itself. After reflecting and consolidating, the bot writes a private
 * first-person diary entry that weaves the day's memories and new insights into
 * a short narrative. This is the most OpenAI-"dreaming"-like step: background
 * synthesis that turns raw experience into a felt, structured account.
 *
 * The diary entry is embedded and stored, so it becomes retrievable context —
 * it can later "remember a dream." We also keep the reasoning trace: the
 * thoughts behind the dream behind the thoughts.
 */
export async function dream(
  store: MemoryStore,
  subjectId: string,
  ingredients: MemoryRecord[],
): Promise<MemoryRecord | null> {
  if (ingredients.length === 0) return null;

  const material = ingredients
    .map((m) => `(${m.kind}, importance ${m.importance.toFixed(0)}) ${m.content}`)
    .join('\n');

  const { text, reasoning } = await reasonedText({
    model: models.dream,
    system: `${renderXmlPersonaTemplate(PERSONA.persona, {
      bot_name: PERSONA.name,
      username: subjectId,
      user_name: subjectId,
      user_input: 'private dream cycle',
      personality_mood: 'reflective',
      social_relationship_level: 'close',
      social_level: 'close',
    })}\n\n${PERSONA.dreamVoice}`,
    prompt:
      `It is the quiet hour. Consolidate the following memories and insights into a single short ` +
      `diary entry (3–6 sentences). Let the important things surface and the trivial things fade.\n\n${material}`,
    temperature: 0.85,
    maxOutputTokens: 1800,
  });
  const diaryEntry = extractPersonaMessage(text);

  const rec = await store.insert({
    subjectId,
    kind: 'diary',
    content: diaryEntry,
    importance: 6,
    embedding: await embedOne(diaryEntry),
    reasoning,
    sources: ingredients.map((m) => m.id),
    meta: { dreamedAt: new Date().toISOString(), rawOutput: text },
  });

  log.info(`subject=${subjectId} wrote a diary entry from ${ingredients.length} memories`);
  return rec;
}
