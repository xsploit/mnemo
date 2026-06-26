import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const SCHEMA = 'neuro_codex_bridge.request.v1';

export function codexBridgeFeatures(): string[] {
  return [
    'queue bounded requests into the configured Codex thread',
    'attach requester/guild/channel/message metadata',
    'read recent bridge result files back through /codex results',
    'optional harness route with inspect profile only',
    'pause/resume/clear local queue controls',
    'writes JSON request files only; does not execute Codex from Discord',
  ];
}

export async function codexBridgeStatus() {
  await ensureDirs();
  const [pending, results, archived, state] = await Promise.all([
    jsonFiles(config.codex.inbox),
    jsonFiles(config.codex.outbox),
    archiveJsonFiles(config.codex.archive),
    readState(),
  ]);
  return {
    enabled: config.codex.enabled,
    paused: Boolean(state.paused),
    root: config.codex.root,
    inboxCount: pending.length,
    outboxCount: results.length,
    archiveCount: archived.length,
    oldestRequest: pending[0]?.name ?? null,
    lastResult: results.at(-1)?.name ?? null,
  };
}

export async function setCodexBridgePaused(paused: boolean, actorId: string): Promise<void> {
  await ensureDirs();
  await writeState({ ...(await readState()), paused, updated_at: new Date().toISOString(), updated_by: actorId });
}

export async function clearPendingCodexBridgeRequests(actorId: string): Promise<number> {
  await ensureDirs();
  const pending = await jsonFiles(config.codex.inbox);
  if (pending.length === 0) return 0;
  const destination = path.join(config.codex.archive, `cleared-${timestamp()}`);
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(pending.map((file) => fs.rename(file.path, path.join(destination, file.name))));
  await writeState({
    ...(await readState()),
    last_clear_at: new Date().toISOString(),
    last_clear_by: actorId,
    last_clear_count: pending.length,
  });
  return pending.length;
}

export async function enqueueCodexBridgeRequest(input: {
  requesterId: string;
  requesterName: string;
  prompt: string;
  route?: 'codex' | 'harness';
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  authorityReason?: string;
}) {
  await ensureDirs();
  if (!config.codex.enabled) throw new Error('Codex bridge is disabled. Set DISCORD_CODEX_BRIDGE_ENABLED=true.');
  if ((await readState()).paused) throw new Error('Codex bridge queue is paused.');
  const route = input.route ?? 'codex';
  const prompt = input.prompt.slice(0, config.codex.promptMaxChars).trim();
  if (!prompt) throw new Error('prompt is required.');
  const id = crypto.randomUUID();
  const deliveryMode = route === 'harness' ? 'harness_brain' : 'thread_heartbeat';
  const payload = {
    schema: SCHEMA,
    id,
    created_at: new Date().toISOString(),
    source: 'discord',
    requester_id: input.requesterId,
    requester_name: input.requesterName,
    guild_id: input.guildId ?? null,
    channel_id: input.channelId ?? null,
    message_id: input.messageId ?? null,
    intent: route === 'harness' ? 'harness' : 'ask_codex',
    priority: 'normal',
    prompt,
    authority: {
      mode: 'manual_owner',
      authorized: true,
      reason: input.authorityReason ?? 'owner Discord turn authorized Codex bridge request',
    },
    delivery: {
      mode: deliveryMode,
      thread_id: config.codex.threadId,
    },
    context: { recent_messages: [], attachments: [], model_suggestion: null },
    harness: { agent: 'claude', permission_profile: 'inspect' },
  };
  const file = `${timestamp()}-${id}.json`;
  const requestPath = path.join(config.codex.inbox, file);
  await fs.writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { file, path: requestPath, deliveryMode };
}

export async function listCodexBridgeResults(limit = 5): Promise<Array<{ file: string; path: string; mtime: number; payload: Record<string, unknown> }>> {
  await ensureDirs();
  const files = (await jsonFiles(config.codex.outbox)).slice(-clampCount(limit, 1, 25)).reverse();
  const results: Array<{ file: string; path: string; mtime: number; payload: Record<string, unknown> }> = [];
  for (const file of files) {
    const payload = await readResult(file.path);
    if (payload) results.push({ file: file.name, path: file.path, mtime: file.mtime, payload });
  }
  return results;
}

export function formatCodexBridgeUpdate(payload: Record<string, unknown>, maxSummaryChars = config.codex.resultSummaryChars): string {
  const status = firstString(payload.status) || 'unknown';
  const processedAt = firstString(payload.processed_at, payload.completed_at, payload.updated_at, payload.processedAt, payload.completedAt, payload.updatedAt) || 'unknown time';
  const details = recordValue(payload.details);
  const summary =
    firstString(payload.summary, payload.final_response, payload.finalResponse, payload.message, details?.summary, details?.message) ?? '';
  const commitId = firstString(payload.commit_id, payload.commitId, payload.commit, details?.commit_id, details?.commitId) ?? '';
  const nextStep = firstString(payload.next_step, payload.nextStep, details?.next_step, details?.nextStep) ?? '';
  const parts = [`- [${processedAt}] Codex \`${status}\``];
  if (commitId) parts.push(`commit \`${compact(commitId, 80)}\``);
  if (summary) parts.push(compact(summary, maxSummaryChars));
  if (nextStep) parts.push(`next: ${compact(nextStep, 240)}`);
  return parts.join(' -- ');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function ensureDirs(): Promise<void> {
  await Promise.all([
    fs.mkdir(config.codex.inbox, { recursive: true }),
    fs.mkdir(config.codex.outbox, { recursive: true }),
    fs.mkdir(config.codex.archive, { recursive: true }),
  ]);
}

async function readState(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(config.codex.statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { paused: false };
  } catch {
    return { paused: false };
  }
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(config.codex.statePath), { recursive: true });
  await fs.writeFile(config.codex.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function readResult(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function jsonFiles(directory: string): Promise<Array<{ name: string; path: string; mtime: number }>> {
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const stat = await fs.stat(filePath);
        return { name: entry.name, path: filePath, mtime: stat.mtimeMs };
      }),
  );
  return files.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
}

async function archiveJsonFiles(directory: string): Promise<Array<{ name: string; path: string; mtime: number }>> {
  await fs.mkdir(directory, { recursive: true });
  const results: Array<{ name: string; path: string; mtime: number }> = [];
  await walkJsonFiles(directory, results);
  return results.sort((left, right) => left.mtime - right.mtime || left.name.localeCompare(right.name));
}

async function walkJsonFiles(directory: string, results: Array<{ name: string; path: string; mtime: number }>): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkJsonFiles(entryPath, results);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const stat = await fs.stat(entryPath);
      results.push({ name: entry.name, path: entryPath, mtime: stat.mtimeMs });
    }
  }
}

function clampCount(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)));
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}
