import { z } from 'zod';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';
import { embedOne } from '../llm/embeddings.js';
import { logger } from '../logger.js';
import type { MemoryRecord, MemoryStore } from '../memory/types.js';

const log = logger('consolidate');

/**
 * Mem0/Zep-style memory operations. Given a batch of raw episodic observations
 * and the existing semantic facts they might touch, the model decides — for each
 * — whether to ADD a new fact, UPDATE (supersede) an old one whose truth has
 * changed, DELETE one that's now wrong, or NOOP. Updated facts get a closed
 * validity window so the history stays queryable ("what did it believe then").
 */
const opSchema = z.object({
  operations: z.array(
    z.object({
      op: z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']),
      fact: z.string().describe('The semantic fact, written as a standalone statement.'),
      targetId: z
        .string()
        .nullable()
        .describe('For UPDATE/DELETE: the id of the existing fact being changed.'),
      importance: z.number().min(1).max(10),
    }),
  ),
});

export interface ConsolidationResult {
  added: MemoryRecord[];
  updated: number;
  deleted: number;
  reasoning: string;
}

export async function consolidate(
  store: MemoryStore,
  subjectId: string,
  observations: MemoryRecord[],
  existingFacts: MemoryRecord[],
): Promise<ConsolidationResult> {
  if (observations.length === 0) return { added: [], updated: 0, deleted: 0, reasoning: 'nothing new' };

  const obsText = observations.map((o) => `- ${o.content}`).join('\n');
  const factText = existingFacts.length
    ? existingFacts.map((f) => `[${f.id}] ${f.content}`).join('\n')
    : '(none yet)';

  const { object, reasoning } = await reasonedObject({
    model: models.json,
    schema: opSchema,
    system:
      'You maintain a companion AI\'s long-term semantic memory about a person. ' +
      'From new observations, distill durable facts. Reconcile them against existing facts: ' +
      'ADD genuinely new facts; UPDATE when a fact\'s truth has changed (cite the old id); ' +
      'DELETE when an existing fact is now false; NOOP for fleeting chatter. ' +
      'Prefer few, high-signal facts over many trivial ones.',
    prompt: `New observations:\n${obsText}\n\nExisting facts:\n${factText}`,
    temperature: 0.2,
  });

  const result: ConsolidationResult = { added: [], updated: 0, deleted: 0, reasoning };
  const now = new Date();

  for (const op of object.operations) {
    try {
      if (op.op === 'NOOP') continue;

      if (op.op === 'DELETE' && op.targetId) {
        await store.expire(op.targetId, now);
        result.deleted++;
        continue;
      }

      if (op.op === 'UPDATE' && op.targetId) {
        await store.expire(op.targetId, now); // close the old fact's validity window
        const rec = await store.insert({
          subjectId,
          kind: 'semantic',
          content: op.fact,
          importance: op.importance,
          embedding: await embedOne(op.fact),
          supersedes: op.targetId,
          reasoning,
          meta: { op: 'UPDATE' },
        });
        result.added.push(rec);
        result.updated++;
        continue;
      }

      if (op.op === 'ADD') {
        const rec = await store.insert({
          subjectId,
          kind: 'semantic',
          content: op.fact,
          importance: op.importance,
          embedding: await embedOne(op.fact),
          reasoning,
          meta: { op: 'ADD' },
        });
        result.added.push(rec);
      }
    } catch (e: any) {
      log.warn(`op ${op.op} failed`, e?.message);
    }
  }

  await store.markProcessed(observations.map((o) => o.id));
  log.info(
    `subject=${subjectId} +${result.added.length} ~${result.updated} -${result.deleted} from ${observations.length} obs`,
  );
  return result;
}
