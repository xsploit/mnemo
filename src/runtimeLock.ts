import fs from 'node:fs/promises';
import path from 'node:path';

interface RuntimeLock {
  pid: number;
  startedAt: string;
  cwd: string;
  argv: string[];
}

export async function acquireRuntimeLock(lockPath = path.resolve('data', 'runtime.lock.json')): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lock: RuntimeLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: process.argv,
  };

  for (;;) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await readLock(lockPath);
        if (current?.pid === process.pid) await fs.unlink(lockPath).catch(() => {});
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readLock(lockPath);
      if (existing?.pid && isProcessAlive(existing.pid)) {
        throw new Error(`Another ${path.basename(process.cwd())} runtime is already running: pid=${existing.pid}`);
      }
      await fs.unlink(lockPath).catch(() => {});
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

async function readLock(lockPath: string): Promise<RuntimeLock | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Partial<RuntimeLock>;
    return typeof parsed.pid === 'number' ? (parsed as RuntimeLock) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
