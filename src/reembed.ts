import fs from 'node:fs/promises';
import path from 'node:path';
import { embedAll } from './llm/embeddings.js';
import { logger } from './logger.js';

/**
 * Re-embed the entire file-backed memory store with the CURRENT embedder
 * (set EMBED_PROVIDER=local first). This makes every stored vector share one
 * embedding space again after switching models, so retrieval stays coherent.
 *
 * Run while the bot is STOPPED (it writes data/memories.json directly).
 *   npm run reembed
 */
const log = logger('reembed');
const BATCH = 48;

async function main() {
  const file = path.resolve('data', 'memories.json');
  let rows: Array<{ content?: string; embedding?: number[] | null }>;
  try {
    rows = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e: any) {
    log.error(`could not read ${file}`, e?.message ?? e);
    process.exit(1);
  }

  const targets = rows.filter((r) => typeof r.content === 'string' && r.content.trim().length > 0);
  log.info(`re-embedding ${targets.length}/${rows.length} memories…`);

  let done = 0;
  let dim = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const vecs = await embedAll(chunk.map((r) => r.content as string));
    chunk.forEach((r, j) => {
      r.embedding = vecs[j] ?? null;
    });
    dim = vecs[0]?.length ?? dim;
    done += chunk.length;
    log.info(`  ${done}/${targets.length}`);
  }

  await fs.writeFile(file, JSON.stringify(rows), 'utf8');
  log.info(`done — re-embedded ${done} memories at ${dim} dims into ${file}`);
  process.exit(0);
}

main();
