import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import {
  DEVELOPMENT_SCHEMA,
  type DevelopmentEvent,
  type DevelopmentEventInput,
  type DevelopmentEventKind,
  type UtilityProjection,
  type UtilityUpdateEventData,
} from './types.js';

const log = logger('development:events');
const DEFAULT_PATH = path.resolve(process.env.DEVELOPMENT_EVENT_PATH ?? path.join('data', 'development', 'events.jsonl'));

export class DevelopmentEventStore {
  private writeTail: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private events: DevelopmentEvent[] = [];
  private dedupeKeys = new Set<string>();

  constructor(private readonly filePath = DEFAULT_PATH) {}

  async append<T>(input: DevelopmentEventInput<T>): Promise<DevelopmentEvent<T>> {
    await this.ensureLoaded();
    if (input.dedupeKey) {
      const existing = this.events.find((event) => event.dedupeKey === input.dedupeKey);
      if (existing) return existing as DevelopmentEvent<T>;
    }

    const event: DevelopmentEvent<T> = {
      schema: DEVELOPMENT_SCHEMA,
      id: crypto.randomUUID(),
      kind: input.kind,
      timestamp: new Date().toISOString(),
      subjectId: input.subjectId,
      channelId: input.channelId,
      evidenceIds: uniqueStrings(input.evidenceIds ?? []).slice(0, 80),
      dedupeKey: input.dedupeKey,
      data: input.data,
    };

    this.events.push(event as DevelopmentEvent);
    if (event.dedupeKey) this.dedupeKeys.add(event.dedupeKey);
    this.writeTail = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    });
    try {
      await this.writeTail;
    } catch (error: any) {
      this.events = this.events.filter((candidate) => candidate.id !== event.id);
      if (event.dedupeKey) this.dedupeKeys.delete(event.dedupeKey);
      this.writeTail = Promise.resolve();
      log.error('append failed', error?.message ?? error);
      throw error;
    }
    return event;
  }

  async list(args: {
    kinds?: DevelopmentEventKind[];
    subjectId?: string;
    channelId?: string;
    since?: Date;
    limit?: number;
  } = {}): Promise<DevelopmentEvent[]> {
    await this.ensureLoaded();
    const sinceMs = args.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const filtered = this.events.filter((event) => {
      if (args.kinds && !args.kinds.includes(event.kind)) return false;
      if (args.subjectId && event.subjectId !== args.subjectId) return false;
      if (args.channelId && event.channelId !== args.channelId) return false;
      if (Date.parse(event.timestamp) < sinceMs) return false;
      return true;
    });
    return args.limit ? filtered.slice(-Math.max(1, args.limit)) : [...filtered];
  }

  async get(id: string): Promise<DevelopmentEvent | null> {
    await this.ensureLoaded();
    return this.events.find((event) => event.id === id) ?? null;
  }

  async hasDedupeKey(key: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.dedupeKeys.has(key);
  }

  async utilityProjection(): Promise<Map<string, UtilityProjection>> {
    const updates = await this.list({ kinds: ['utility_update'] });
    const projection = new Map<string, UtilityProjection>();
    for (const event of updates) {
      const data = event.data as unknown as UtilityUpdateEventData;
      if (!isUtilityUpdate(data)) continue;
      const key = utilityKey(data.targetType, data.targetId, data.contextKey);
      projection.set(key, {
        targetType: data.targetType,
        targetId: data.targetId,
        contextKey: data.contextKey,
        value: clamp(data.next, -1, 1),
        updates: (projection.get(key)?.updates ?? 0) + 1,
        lastUpdatedAt: event.timestamp,
      });
    }
    return projection;
  }

  async reload(): Promise<void> {
    await this.writeTail;
    this.loaded = false;
    this.loadPromise = null;
    this.events = [];
    this.dedupeKeys.clear();
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk().finally(() => {
        this.loaded = true;
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') log.warn('could not load development events', error?.message ?? error);
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isDevelopmentEvent(parsed)) continue;
        this.events.push(parsed);
        if (parsed.dedupeKey) this.dedupeKeys.add(parsed.dedupeKey);
      } catch {
        // Append-only logs preserve later valid records even if one line is damaged.
      }
    }
    log.info(`loaded ${this.events.length} developmental event(s)`);
  }
}

export function utilityKey(targetType: string, targetId: string, contextKey = 'global'): string {
  return `${targetType}:${targetId}:${contextKey}`;
}

function isDevelopmentEvent(value: unknown): value is DevelopmentEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<DevelopmentEvent>;
  return (
    event.schema === DEVELOPMENT_SCHEMA &&
    typeof event.id === 'string' &&
    typeof event.kind === 'string' &&
    typeof event.timestamp === 'string' &&
    Array.isArray(event.evidenceIds) &&
    Boolean(event.data && typeof event.data === 'object')
  );
}

function isUtilityUpdate(value: unknown): value is UtilityUpdateEventData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const update = value as Partial<UtilityUpdateEventData>;
  return (
    (update.targetType === 'memory' || update.targetType === 'strategy' || update.targetType === 'prediction') &&
    typeof update.targetId === 'string' &&
    typeof update.contextKey === 'string' &&
    typeof update.next === 'number'
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

let singleton: DevelopmentEventStore | null = null;

export function getDevelopmentStore(): DevelopmentEventStore {
  singleton ??= new DevelopmentEventStore();
  return singleton;
}
