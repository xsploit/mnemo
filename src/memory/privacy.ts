import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
  private loadPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
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
    await this.mutate(() => {
      this.state.subjects[subjectId] = {
        optedOut: true,
        updatedAt: new Date().toISOString(),
        actorId,
        reason,
      };
    });
  }

  async resume(subjectId: string, actorId: string, reason: string): Promise<void> {
    await this.mutate(() => {
      this.state.subjects[subjectId] = {
        optedOut: false,
        updatedAt: new Date().toISOString(),
        actorId,
        reason,
      };
    });
  }

  private async load(): Promise<void> {
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
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, this.path);
  }

  private async mutate(fn: () => void): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      await this.load();
      fn();
      await this.save();
    });
    this.mutationTail = operation.catch(() => undefined);
    return operation;
  }
}

export const memoryPrivacy = new FileMemoryPrivacyStore();
