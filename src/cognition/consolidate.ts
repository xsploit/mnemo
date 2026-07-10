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
      basis: z.array(z.number().int().min(0)).min(1).max(20).describe('Indices of new observations supporting this operation.'),
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

  let object: z.infer<typeof opSchema>;
  let reasoning: string;
  try {
    ({ object, reasoning } = await reasonedObject({
      model: models.json,
      schema: opSchema,
      system:
        'You maintain a companion AI\'s long-term semantic memory about a person. ' +
        'From new observations, distill durable facts. Reconcile them against existing facts: ' +
        'ADD genuinely new facts; UPDATE when a fact\'s truth has changed (cite the old id); ' +
        'DELETE when an existing fact is now false; NOOP for fleeting chatter. ' +
        'Every operation must cite the supporting new-observation indices in basis. ' +
        'Prefer few, high-signal facts over many trivial ones.',
      prompt: `New observations:\n${obsText}\n\nExisting facts:\n${factText}`,
      temperature: 0.2,
    }));
  } catch (e: any) {
    reasoning = `consolidation model failed; episodic memories remain retryable: ${e?.message ?? e}`;
    log.warn(`subject=${subjectId} consolidation skipped; retained ${observations.length} unprocessed observation(s)`, e?.message);
    return { added: [], updated: 0, deleted: 0, reasoning };
  }

  const result: ConsolidationResult = { added: [], updated: 0, deleted: 0, reasoning };
  const now = new Date();
  const visibleFactIds = new Set(existingFacts.map((fact) => fact.id));
  const knownContents = new Set(existingFacts.filter((fact) => !fact.validTo).map((fact) => normalizeFact(fact.content)));
  let operationFailures = 0;
  const retryObservationIds = new Set<string>();

  for (const op of object.operations) {
    const sourceIds = [...new Set(op.basis.map((index) => observations[index]?.id).filter((id): id is string => Boolean(id)))];
    try {
      if (op.op === 'NOOP') continue;
      if (sourceIds.length === 0) {
        operationFailures += 1;
        log.warn(`rejected ${op.op} without a valid observation basis`);
        continue;
      }

      if (op.op === 'DELETE' && op.targetId) {
        if (!visibleFactIds.has(op.targetId)) {
          operationFailures += 1;
          log.warn(`rejected DELETE with unknown target ${op.targetId}`);
          continue;
        }
        await store.expire(op.targetId, now);
        result.deleted++;
        continue;
      }

      if (op.op === 'UPDATE' && op.targetId) {
        if (!visibleFactIds.has(op.targetId)) {
          operationFailures += 1;
          log.warn(`rejected UPDATE with unknown target ${op.targetId}`);
          continue;
        }
        const rec = await store.insert({
          subjectId,
          kind: 'semantic',
          content: op.fact,
          importance: op.importance,
          embedding: await embedOne(op.fact),
          supersedes: op.targetId,
          reasoning,
          sources: sourceIds,
          meta: { op: 'UPDATE' },
        });
        await store.expire(op.targetId, now); // close the old fact only after its replacement exists
        result.added.push(rec);
        knownContents.add(normalizeFact(op.fact));
        result.updated++;
        continue;
      }

      if (op.op === 'ADD') {
        const normalized = normalizeFact(op.fact);
        if (!normalized || knownContents.has(normalized)) continue;
        const rec = await store.insert({
          subjectId,
          kind: 'semantic',
          content: op.fact,
          importance: op.importance,
          embedding: await embedOne(op.fact),
          reasoning,
          sources: sourceIds,
          meta: { op: 'ADD' },
        });
        result.added.push(rec);
        knownContents.add(normalized);
      }
    } catch (e: any) {
      operationFailures += 1;
      for (const id of sourceIds) retryObservationIds.add(id);
      log.warn(`op ${op.op} failed`, e?.message);
    }
  }

  const processedIds = observations.map((observation) => observation.id).filter((id) => !retryObservationIds.has(id));
  if (processedIds.length) await store.markProcessed(processedIds);
  if (retryObservationIds.size) {
    log.warn(
      `subject=${subjectId} left ${retryObservationIds.size} observation(s) retryable after ${operationFailures} failed operation(s)`,
    );
  }
  log.info(
    `subject=${subjectId} +${result.added.length} ~${result.updated} -${result.deleted} from ${observations.length} obs`,
  );
  return result;
}

function normalizeFact(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?]+$/g, '');
}
