import { z } from 'zod';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';
import { logger } from '../logger.js';
import { selfModelStore, type SelfNoteEdit } from './selfModel.js';
import type { PersonaAffect } from '../llm/personaOutput.js';
import type { MemoryRecord } from '../memory/types.js';

const log = logger('self-reflect');

const editSchema = z.object({
  noteEdits: z
    .array(
      z.object({
        op: z.enum(['add', 'revise', 'drop']),
        note: z.string().optional(),
        targetIndex: z.number().int().nullable().optional(),
      }),
    )
    .max(2)
    .default([]),
});

/**
 * The "self" half of dreaming. While consolidating what she's learned about a
 * person, she also reflects on what she's learning about *herself* — drifting her
 * resting mood toward what she actually felt, and editing a tiny first-person
 * self-concept. This is what makes her a measurably different person over months,
 * not a static prompt. Best-effort: a model failure still drifts the baseline.
 */
export async function evolveSelf(args: {
  diaryText: string | null;
  reflections: MemoryRecord[];
  observations: MemoryRecord[];
}): Promise<string[]> {
  const recentAffects = args.observations
    .map((o) => (o.meta?.['affect'] as PersonaAffect | undefined) ?? null)
    .filter((a): a is PersonaAffect => Boolean(a));

  let noteEdits: SelfNoteEdit[] = [];
  try {
    const current = await selfModelStore.get();
    const notesList = current.selfNotes.length
      ? current.selfNotes.map((n, i) => `[${i}] ${n}`).join('\n')
      : '(none yet)';
    const insights = args.reflections.map((r) => `- ${r.content}`).join('\n') || '(none)';

    const { object } = await reasonedObject({
      model: models.json,
      schema: editSchema,
      system:
        'You are the private self-reflection of a companion AI, run while she sleeps. From her recent ' +
        'diary and how she felt, propose at most TWO small edits to her FIRST-PERSON self-notes — durable ' +
        'truths about who she is becoming (e.g. "I get sharp when people are vague", "I soften fast for ' +
        'people who are honest with me"). Add only genuinely new self-knowledge, revise a stale note, or ' +
        'drop one that no longer fits. Keep notes short, specific, and in her own voice. Most nights, ' +
        'propose nothing. Do not restate facts about other people.',
      prompt: `Her current self-notes:\n${notesList}\n\nTonight's diary:\n${args.diaryText ?? '(no diary)'}\n\nRecent insights:\n${insights}`,
      temperature: 0.4,
      maxOutputTokens: 1024,
    });
    noteEdits = object.noteEdits as SelfNoteEdit[];
  } catch (e: any) {
    log.warn('self-note reflection failed; drifting baseline only', e?.message);
  }

  const { changed } = await selfModelStore.evolve({ recentAffects, noteEdits });
  if (changed.length) log.info(`self evolved: ${changed.join('; ')}`);
  return changed;
}
