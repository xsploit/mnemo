import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { consolidate } from '../cognition/consolidate.js';
import { reflect } from '../cognition/reflect.js';
import { FileMemoryStore } from '../memory/store-file.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hikari-sleep-smoke-'));
try {
  const store = new FileMemoryStore(path.join(root, 'memories.json'));
  await store.ready();
  const subjectId = 'sleep-smoke-user';
  const observations = await Promise.all([
    store.insert({
      subjectId,
      kind: 'episodic',
      content: 'SUBSECT said Hikari is the only bot receiving the developmental experiment for now.',
      importance: 8,
    }),
    store.insert({
      subjectId,
      kind: 'episodic',
      content: 'SUBSECT said Hikari must use DeepSeek V4 Pro for main chat and V4 Flash for worker JSON.',
      importance: 9,
    }),
    store.insert({
      subjectId,
      kind: 'episodic',
      content: 'SUBSECT wants local all-MiniLM embeddings to remain authoritative and avoid embedding API cost.',
      importance: 8,
    }),
  ]);

  const consolidation = await consolidate(store, subjectId, observations, []);
  assert.ok(consolidation.added.length > 0, 'Flash returned no semantic facts for three durable observations.');
  for (const fact of consolidation.added) {
    assert.ok(fact.sources.length > 0, `semantic fact ${fact.id} has no evidence sources`);
    assert.ok(fact.sources.every((id) => observations.some((observation) => observation.id === id)));
  }

  const reflection = await reflect(store, subjectId, [...observations, ...consolidation.added]);
  for (const insight of reflection.created) {
    assert.ok(insight.sources.length > 0, `reflection ${insight.id} has no evidence sources`);
    assert.equal(insight.meta['epistemicStatus'], 'inference');
    assert.equal(typeof insight.meta['confidence'], 'number');
  }

  console.log(
    JSON.stringify(
      {
        semanticFacts: consolidation.added.map((fact) => ({ content: fact.content, sourceCount: fact.sources.length })),
        reflections: reflection.created.map((insight) => ({
          content: insight.content,
          sourceCount: insight.sources.length,
          confidence: insight.meta['confidence'],
          epistemicStatus: insight.meta['epistemicStatus'],
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
