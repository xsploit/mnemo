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
  /** Deduplicates real feedback/reaction evidence used to change the relationship. */
  evidenceKeys: string[];
  lastOutcomeAt?: string;
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
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(userId: string): Promise<AffinityView> {
    const entry = (await this.load()).get(userId);
    return deriveView(entry);
  }

  /**
   * Legacy compatibility path. New live code must not call this with Hikari's
   * generated affect because her own output is not evidence about the user.
   */
  async update(userId: string, userName: string, affect: PersonaAffect | null): Promise<AffinityView> {
    const view = await this.observeInteraction(userId, userName);
    if (!affect) return view;
    return this.applyOutcome({
      userId,
      userName,
      evidenceKey: `legacy-generated-affect:${Date.now()}`,
      valence: affect.valence ?? 0,
      warmth: affect.socialEnergy ?? ((affect.valence ?? 0) + 1) / 2,
    });
  }

  /** Count familiarity without treating Hikari's generated mood as user evidence. */
  async observeInteraction(userId: string, userName: string): Promise<AffinityView> {
    return this.mutate(async (entries) => {
      const prev = entries.get(userId);
      const now = new Date().toISOString();
      const entry: AffinityEntry = {
        userId,
        userName: userName || prev?.userName || userId,
        interactions: (prev?.interactions ?? 0) + 1,
        valenceEma: prev?.valenceEma ?? 0,
        warmthEma: prev?.warmthEma ?? 0.5,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        evidenceKeys: prev?.evidenceKeys ?? [],
        lastOutcomeAt: prev?.lastOutcomeAt,
      };
      entries.set(userId, entry);
      return deriveView(entry);
    });
  }

  /** Apply a deduplicated relationship update derived from observed evidence. */
  async applyOutcome(args: {
    userId: string;
    userName: string;
    evidenceKey: string;
    valence: number;
    warmth: number;
  }): Promise<AffinityView> {
    return this.mutate(async (entries) => {
      const prev = entries.get(args.userId);
      if (prev?.evidenceKeys.includes(args.evidenceKey)) return deriveView(prev);
      const now = new Date().toISOString();
      const evidenceKeys = [...(prev?.evidenceKeys ?? []), args.evidenceKey].slice(-200);
      const entry: AffinityEntry = {
        userId: args.userId,
        userName: args.userName || prev?.userName || args.userId,
        interactions: prev?.interactions ?? 0,
        valenceEma: prev ? ema(prev.valenceEma, clampNum(args.valence, -1, 1), 0.15) : clampNum(args.valence, -1, 1),
        warmthEma: prev ? ema(prev.warmthEma, clampNum(args.warmth, 0, 1), 0.15) : clampNum(args.warmth, 0, 1),
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: prev?.lastSeenAt ?? now,
        evidenceKeys,
        lastOutcomeAt: now,
      };
      entries.set(args.userId, entry);
      return deriveView(entry);
    });
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
        evidenceKeys: Array.isArray(value.evidenceKeys)
          ? value.evidenceKeys.filter((key): key is string => typeof key === 'string').slice(-200)
          : [],
        lastOutcomeAt: typeof value.lastOutcomeAt === 'string' ? value.lastOutcomeAt : undefined,
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

  private async mutate<T>(fn: (entries: Map<string, AffinityEntry>) => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const entries = await this.load();
      const result = await fn(entries);
      await this.save(entries);
      return result;
    });
    this.mutationTail = operation.catch(() => undefined);
    return operation;
  }
}

function ema(prev: number, next: number, alpha = EMA_ALPHA): number {
  return prev * (1 - alpha) + next * alpha;
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
