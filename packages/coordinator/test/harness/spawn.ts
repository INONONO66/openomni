import type { Subprocess } from "bun";

export interface SpawnedProcess {
  proc: Subprocess;
  kill: () => Promise<void>;
}

const registry: SpawnedProcess[] = [];

export function spawnBunProcess(scriptPath: string, args: string[] = []): SpawnedProcess {
  const proc = Bun.spawn(["bun", scriptPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const handle: SpawnedProcess = {
    proc,
    kill: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };

  registry.push(handle);
  return handle;
}

export async function cleanupAll(): Promise<void> {
  await Promise.all(
    registry.map((h) => {
      h.proc.kill("SIGTERM");
      return h.proc.exited;
    }),
  );
  registry.length = 0;
}
