const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function getMinLevel(): Level {
  const env = process.env.OPENOMNI_LOG_LEVEL?.toLowerCase();
  return (env && env in LEVELS ? env : "info") as Level;
}

function write(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[getMinLevel()]) return;
  const line = JSON.stringify({
    ts: Date.now(),
    level,
    pid: process.pid,
    component: process.env.OPENOMNI_PROCESS ?? "unknown",
    msg,
    ...ctx,
  });
  process.stdout.write(`${line}\n`);
}

export namespace Log {
  export const debug = (msg: string, ctx?: Record<string, unknown>) => write("debug", msg, ctx);
  export const info = (msg: string, ctx?: Record<string, unknown>) => write("info", msg, ctx);
  export const warn = (msg: string, ctx?: Record<string, unknown>) => write("warn", msg, ctx);
  export const error = (msg: string, ctx?: Record<string, unknown>) => write("error", msg, ctx);

  export function withContext(baseCtx: Record<string, unknown>) {
    return {
      debug: (msg: string, ctx?: Record<string, unknown>) =>
        write("debug", msg, { ...baseCtx, ...ctx }),
      info: (msg: string, ctx?: Record<string, unknown>) =>
        write("info", msg, { ...baseCtx, ...ctx }),
      warn: (msg: string, ctx?: Record<string, unknown>) =>
        write("warn", msg, { ...baseCtx, ...ctx }),
      error: (msg: string, ctx?: Record<string, unknown>) =>
        write("error", msg, { ...baseCtx, ...ctx }),
    };
  }
}
