import fs from 'node:fs/promises';
import path from 'node:path';
import type { PersonaAffect } from '../llm/personaOutput.js';

const AFFINITY_SCHEMA = 'mnemo.affinity.v1';
const AFFINITY_PATH = path.resolve('data', 'affinity.json');
const EMA_ALPHA = 0.25; // weight of the newest turn vs. running history

export interface AffinityEntry {
  userId: string;
  userName: string;
  interactions: number;
  /** Exponential moving average of pleasantness, -1..1. */
  valenceEma: number;
  /** Exponential moving average of social energy/warmth, 0..1. */
  warmthEma: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** How Akari/Hikari relates to a user right now, derived from accumulated affect. */
export interface AffinityView {
  level: string; // stranger | acquaintance | warming up | friendly | bestie | on thin ice | prickly
  trustPercent: number; // 0..100
  warmthPercent: number; // 0..100
  interactions: number;
  valenceEma: number;
}

interface AffinityPayload {
  schema?: string;
  entries?: Record<string, Partial<AffinityEntry>>;
}

export class AffinityStore {
  constructor(private readonly filePath: string) {}

  async get(userId: string): Promise<AffinityView> {
    const entry = (await this.load()).get(userId);
    return deriveView(entry);
  }

  /** Fold this turn's affect into the running relationship signal. */
  async update(userId: string, userName: string, affect: PersonaAffect | null): Promise<AffinityView> {
    const entries = await this.load();
    const prev = entries.get(userId);
    const now = new Date().toISOString();

    const valence = affect?.valence ?? 0;
    const warmth = affect?.socialEnergy ?? (valence + 1) / 2;

    const entry: AffinityEntry = {
      userId,
      userName: userName || prev?.userName || userId,
      interactions: (prev?.interactions ?? 0) + 1,
      valenceEma: prev ? ema(prev.valenceEma, valence) : valence,
      warmthEma: prev ? ema(prev.warmthEma, warmth) : warmth,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    entries.set(userId, entry);
    await this.save(entries);
    return deriveView(entry);
  }

  async list(): Promise<AffinityEntry[]> {
    return [...(await this.load()).values()].sort((a, b) => b.interactions - a.interactions);
  }

  private async load(): Promise<Map<string, AffinityEntry>> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return new Map();
    }
    let payload: AffinityPayload;
    try {
      payload = JSON.parse(raw) as AffinityPayload;
    } catch {
      return new Map();
    }
    const entries = new Map<string, AffinityEntry>();
    for (const [key, value] of Object.entries(payload.entries ?? {})) {
      const userId = String(value.userId ?? key).trim();
      if (!userId) continue;
      entries.set(userId, {
        userId,
        userName: typeof value.userName === 'string' ? value.userName : userId,
        interactions: clampNum(Number(value.interactions ?? 0), 0, Number.MAX_SAFE_INTEGER),
        valenceEma: clampNum(Number(value.valenceEma ?? 0), -1, 1),
        warmthEma: clampNum(Number(value.warmthEma ?? 0.5), 0, 1),
        firstSeenAt: typeof value.firstSeenAt === 'string' ? value.firstSeenAt : '',
        lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : '',
      });
    }
    return entries;
  }

  private async save(entries: Map<string, AffinityEntry>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = {
      schema: AFFINITY_SCHEMA,
      entries: Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

function ema(prev: number, next: number): number {
  return prev * (1 - EMA_ALPHA) + next * EMA_ALPHA;
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function deriveView(entry: AffinityEntry | undefined): AffinityView {
  if (!entry) {
    return { level: 'stranger', trustPercent: 40, warmthPercent: 50, interactions: 0, valenceEma: 0 };
  }
  const { interactions, valenceEma, warmthEma } = entry;
  // Trust grows with familiarity (capped) and is pulled up/down by felt pleasantness.
  const familiarity = Math.min(interactions, 30) / 30; // 0..1
  const trustPercent = Math.round(clampNum(45 + familiarity * 25 + valenceEma * 25, 0, 100));
  const warmthPercent = Math.round(clampNum(warmthEma * 100, 0, 100));

  let level: string;
  if (valenceEma <= -0.45) level = interactions >= 4 ? 'prickly' : 'on thin ice';
  else if (interactions < 2) level = 'stranger';
  else if (interactions < 6) level = 'acquaintance';
  else if (valenceEma >= 0.45 && interactions >= 14) level = 'bestie';
  else if (valenceEma >= 0.2) level = 'friendly';
  else level = 'warming up';

  return { level, trustPercent, warmthPercent, interactions, valenceEma };
}

export const affinityStore = new AffinityStore(AFFINITY_PATH);
