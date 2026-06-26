const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const tag = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  if (extra !== undefined) console.log(tag, msg, extra);
  else console.log(tag, msg);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
