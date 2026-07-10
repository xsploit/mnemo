import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { models } from '../llm/gateway.js';
import { reasonedObject } from '../llm/reason.js';
import { logger } from '../logger.js';
import type { MemoryRecord } from '../memory/types.js';
import { getDevelopmentStore } from './eventStore.js';
import type { DreamSimulation, DreamSimulationEventData } from './types.js';

const log = logger('development:rehearse');

const rehearsalSchema = z.object({
  simulations: z.array(
    z.object({
      title: z.string().max(120),
      premise: z.string().max(400),
      possibleUserMove: z.string().max(300),
      responseStance: z.string().max(300),
      uncertainty: z.string().max(260),
      confidence: z.number().min(0.05).max(0.95),
      basis: z.array(z.number().int().min(0)).max(8),
    }),
  ),
});

export async function rehearseFuture(args: {
  subjectId: string;
  cycleId: string;
  ingredients: MemoryRecord[];
}): Promise<DreamSimulation[]> {
  const limit = config.development.simulationsPerDream;
  if (!config.development.enabled || limit <= 0 || args.ingredients.length === 0) return [];
  const ingredients = args.ingredients.slice(0, 18);
  const numbered = ingredients
    .map((memory, index) => `${index}. [${memory.id}] (${memory.kind}, importance ${memory.importance}) ${memory.content}`)
    .join('\n');

  let raw: z.infer<typeof rehearsalSchema>['simulations'];
  try {
    const { object } = await reasonedObject({
      model: models.json,
      schema: rehearsalSchema,
      system: `You run Hikari's prospective dream rehearsal. Imagine a few plausible future conversational situations that could grow from the supplied memories.

Rules:
- These are simulations, never historical facts or predictions presented as certainty.
- Ground every simulation in supplied memory indices.
- Prefer unresolved questions, surprising tensions, likely follow-ups, and opportunities for a natural callback.
- The response stance is an intention, not scripted dialogue.
- Preserve uncertainty. Do not invent private facts about anyone.
- Return no more than ${limit} simulations.`,
      prompt: `Sleep cycle ${args.cycleId}. Rehearse possible futures from:\n${numbered}`,
      temperature: 0.65,
      maxOutputTokens: 1800,
    });
    raw = object.simulations.slice(0, limit);
  } catch (error: any) {
    log.warn(`subject=${args.subjectId} rehearsal skipped`, error?.message ?? error);
    return [];
  }

  const simulations: DreamSimulation[] = [];
  for (const candidate of raw) {
    const sourceMemoryIds = [...new Set(candidate.basis.map((index) => ingredients[index]?.id).filter((id): id is string => Boolean(id)))];
    if (sourceMemoryIds.length === 0) continue;
    const simulation: DreamSimulation = {
      simulationId: crypto.randomUUID(),
      title: candidate.title,
      premise: candidate.premise,
      possibleUserMove: candidate.possibleUserMove,
      responseStance: candidate.responseStance,
      uncertainty: candidate.uncertainty,
      confidence: candidate.confidence,
      sourceMemoryIds,
    };
    await getDevelopmentStore().append<DreamSimulationEventData>({
      kind: 'dream_simulation',
      subjectId: args.subjectId,
      evidenceIds: sourceMemoryIds.map((id) => `memory:${id}`),
      dedupeKey: `dream-simulation:${args.cycleId}:${simulation.simulationId}`,
      data: { cycleId: args.cycleId, simulation },
    });
    simulations.push(simulation);
  }
  log.info(`subject=${args.subjectId} rehearsed ${simulations.length} possible future(s)`);
  return simulations;
}
