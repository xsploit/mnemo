import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 'mnemo.workspaces.v1';
const STORE_PATH = path.resolve('data', 'workspaces.json');

export interface Workspace {
  threadId: string;
  ownerId: string;
  name: string;
  channelId: string;
  guildId: string;
  createdAt: string;
}

interface Payload {
  schema?: string;
  workspaces?: Record<string, Partial<Workspace>>;
}

/**
 * Private "chat" threads created by /cc. Each is owned by its creator; Hikari is
 * a member (she created it) so she replies in it without an @mention. Persisted
 * so ownership + auto-respond survive restarts.
 */
class WorkspaceStore {
  private cache: Map<string, Workspace> | null = null;

  constructor(private readonly filePath = STORE_PATH) {}

  async add(ws: Workspace): Promise<void> {
    const all = await this.load();
    all.set(ws.threadId, ws);
    await this.save(all);
  }

  async get(threadId: string): Promise<Workspace | null> {
    return (await this.load()).get(threadId) ?? null;
  }

  async isWorkspace(threadId: string): Promise<boolean> {
    return (await this.load()).has(threadId);
  }

  async byOwner(ownerId: string): Promise<Workspace[]> {
    return [...(await this.load()).values()].filter((w) => w.ownerId === ownerId);
  }

  async remove(threadId: string): Promise<boolean> {
    const all = await this.load();
    const removed = all.delete(threadId);
    if (removed) await this.save(all);
    return removed;
  }

  private async load(): Promise<Map<string, Workspace>> {
    if (this.cache) return this.cache;
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Payload;
      const map = new Map<string, Workspace>();
      for (const [threadId, w] of Object.entries(payload.workspaces ?? {})) {
        if (!w.ownerId || !w.channelId) continue;
        map.set(threadId, {
          threadId,
          ownerId: String(w.ownerId),
          name: typeof w.name === 'string' ? w.name : 'workspace',
          channelId: String(w.channelId),
          guildId: typeof w.guildId === 'string' ? w.guildId : '',
          createdAt: typeof w.createdAt === 'string' ? w.createdAt : '',
        });
      }
      this.cache = map;
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private async save(all: Map<string, Workspace>): Promise<void> {
    this.cache = all;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: Payload = { schema: SCHEMA, workspaces: Object.fromEntries(all) };
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

export const workspaceStore = new WorkspaceStore();
