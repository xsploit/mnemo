import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const TTS_SCHEMA = 'mnemo.tts-policy.v1';
const TTS_PATH = path.resolve('data', 'tts-policy.json');

interface TtsPayload {
  schema?: string;
  /** Per-channel explicit overrides. Absent = use the global default. */
  channels?: Record<string, boolean>;
}

/**
 * Where Hikari attaches a voice clip. A per-channel override beats the global
 * default (config.fish.enabledByDefault). Cached in memory; persisted so the
 * setting survives restarts.
 */
class TtsPolicyStore {
  private overrides: Map<string, boolean> | null = null;

  constructor(private readonly filePath = TTS_PATH) {}

  async isEnabled(channelId: string): Promise<boolean> {
    const overrides = await this.load();
    return overrides.get(channelId) ?? config.fish.enabledByDefault;
  }

  async set(channelId: string, enabled: boolean): Promise<void> {
    const overrides = await this.load();
    overrides.set(channelId, enabled);
    await this.save(overrides);
  }

  async clear(channelId: string): Promise<void> {
    const overrides = await this.load();
    if (overrides.delete(channelId)) await this.save(overrides);
  }

  private async load(): Promise<Map<string, boolean>> {
    if (this.overrides) return this.overrides;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const payload = JSON.parse(raw) as TtsPayload;
      this.overrides = new Map(Object.entries(payload.channels ?? {}).map(([k, v]) => [k, Boolean(v)]));
    } catch {
      this.overrides = new Map();
    }
    return this.overrides;
  }

  private async save(overrides: Map<string, boolean>): Promise<void> {
    this.overrides = overrides;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = { schema: TTS_SCHEMA, channels: Object.fromEntries(overrides) };
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }
}

export const ttsPolicy = new TtsPolicyStore();
