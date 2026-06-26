import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const SHITLIST_SCHEMA = 'mnemo.discord-shitlist.v1';
const SHITLIST_PATH = path.resolve('data', 'discord-shitlist.json');

export interface DiscordShitlistEntry {
  userId: string;
  reason: string;
  spiceLevel: number;
  addedAt: string;
  addedBy?: string | undefined;
}

interface ShitlistPayload {
  schema?: string;
  entries?: Record<string, Partial<DiscordShitlistEntry>>;
}

export class DiscordShitlistStore {
  private readonly ownerUserIds: Set<string>;

  constructor(private readonly filePath: string, ownerUserIds: readonly string[]) {
    this.ownerUserIds = new Set(ownerUserIds.map((id) => id.trim()).filter(Boolean));
  }

  async list(): Promise<DiscordShitlistEntry[]> {
    const entries = await this.load();
    return [...entries.values()].sort((left, right) => right.spiceLevel - left.spiceLevel || left.userId.localeCompare(right.userId));
  }

  async get(userId: string | null | undefined): Promise<DiscordShitlistEntry | null> {
    if (!userId || this.ownerUserIds.has(userId)) return null;
    return (await this.load()).get(userId) ?? null;
  }

  async add(userId: string, options: { reason: string; spiceLevel: number; addedBy: string }): Promise<DiscordShitlistEntry> {
    const normalized = userId.trim();
    if (!normalized) throw new Error('Missing user id.');
    if (this.ownerUserIds.has(normalized)) throw new Error('Bot owner cannot be added to the shitlist.');

    const entries = await this.load();
    const entry: DiscordShitlistEntry = {
      userId: normalized,
      reason: cleanReason(options.reason),
      spiceLevel: clampSpice(options.spiceLevel),
      addedAt: new Date().toISOString(),
      addedBy: options.addedBy,
    };
    entries.set(normalized, entry);
    await this.save(entries);
    return entry;
  }

  async remove(userId: string): Promise<boolean> {
    const normalized = userId.trim();
    const entries = await this.load();
    const removed = entries.delete(normalized);
    if (removed) await this.save(entries);
    return removed;
  }

  private async load(): Promise<Map<string, DiscordShitlistEntry>> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return new Map();
    }

    let payload: ShitlistPayload;
    try {
      payload = JSON.parse(raw) as ShitlistPayload;
    } catch {
      return new Map();
    }

    const entries = new Map<string, DiscordShitlistEntry>();
    for (const [key, value] of Object.entries(payload.entries ?? {})) {
      const userId = String(value.userId ?? key).trim();
      if (!userId || this.ownerUserIds.has(userId)) continue;
      entries.set(userId, {
        userId,
        reason: cleanReason(String(value.reason ?? 'manual')),
        spiceLevel: clampSpice(Number(value.spiceLevel ?? 1)),
        addedAt: typeof value.addedAt === 'string' ? value.addedAt : '',
        addedBy: typeof value.addedBy === 'string' ? value.addedBy : undefined,
      });
    }
    return entries;
  }

  private async save(entries: Map<string, DiscordShitlistEntry>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = {
      schema: SHITLIST_SCHEMA,
      entries: Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

export const shitlistStore = new DiscordShitlistStore(SHITLIST_PATH, config.bot.ownerUserIds);

export function formatShitlistStatus(entries: DiscordShitlistEntry[]): string {
  if (entries.length === 0) return 'Shitlist is empty.';
  return entries
    .map((entry, index) =>
      [
        `${index + 1}. <@${entry.userId}> spice=${entry.spiceLevel}`,
        `reason=${entry.reason}`,
        `added=${entry.addedAt || 'unknown'}`,
        entry.addedBy ? `by=<@${entry.addedBy}>` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n');
}

export function formatShitlistReply(entry: DiscordShitlistEntry): string {
  if (entry.spiceLevel <= 3) return 'nah.';
  if (entry.spiceLevel <= 6) return `nah. you're on the list: ${entry.reason}.`;
  if (entry.spiceLevel <= 9) return `not answering that. listed for ${entry.reason}.`;
  return `absolutely not. spice 10 entry: ${entry.reason}.`;
}

function cleanReason(reason: string): string {
  const cleaned = reason.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 240) : 'manual';
}

function clampSpice(value: number): number {
  return Math.min(10, Math.max(1, Number.isFinite(value) ? Math.trunc(value) : 1));
}
