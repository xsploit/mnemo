import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type PrivacyEntry = {
  optedOut: boolean;
  updatedAt: string;
  actorId?: string;
  reason?: string;
};

type PrivacyState = {
  schema: 'mnemo.memory-privacy.v1';
  subjects: Record<string, PrivacyEntry>;
};

export class FileMemoryPrivacyStore {
  private loaded = false;
  private state: PrivacyState = { schema: 'mnemo.memory-privacy.v1', subjects: {} };

  constructor(private readonly path = 'data/privacy.json') {}

  async isOptedOut(subjectId: string): Promise<boolean> {
    await this.load();
    return this.state.subjects[subjectId]?.optedOut === true;
  }

  async status(subjectId: string): Promise<PrivacyEntry | null> {
    await this.load();
    return this.state.subjects[subjectId] ?? null;
  }

  async pause(subjectId: string, actorId: string, reason: string): Promise<void> {
    await this.load();
    this.state.subjects[subjectId] = {
      optedOut: true,
      updatedAt: new Date().toISOString(),
      actorId,
      reason,
    };
    await this.save();
  }

  async resume(subjectId: string, actorId: string, reason: string): Promise<void> {
    await this.load();
    this.state.subjects[subjectId] = {
      optedOut: false,
      updatedAt: new Date().toISOString(),
      actorId,
      reason,
    };
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PrivacyState>;
      this.state = {
        schema: 'mnemo.memory-privacy.v1',
        subjects: parsed.subjects ?? {},
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.state, null, 2));
  }
}

export const memoryPrivacy = new FileMemoryPrivacyStore();
