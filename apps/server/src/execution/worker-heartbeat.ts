import type { WorkerBootstrap } from "@openomni/protocol";
import { z } from "zod";

const DEFAULT_INTERVAL_MS = 15_000;

export namespace WorkerHeartbeat {
  export const SnapshotInput = z.object({
    activeRunIds: z.array(z.string()),
    configEpoch: z.string(),
    memoryRssMb: z.number(),
    lastHeartbeat: z.number(),
  });
  export type SnapshotInput = z.infer<typeof SnapshotInput>;

  export const Server = z.custom<{
    call(method: "worker.heartbeat", params: Record<string, unknown>): Promise<unknown>;
  }>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "call" in value &&
      typeof value.call === "function",
  );
  export type Server = z.infer<typeof Server>;

  export const Options = z.object({
    workerId: z.string(),
    ipcAuthToken: z.string(),
    server: Server,
    getActiveRunIds: z.custom<() => string[]>((value) => typeof value === "function"),
    getConfigEpoch: z.custom<() => string>((value) => typeof value === "function"),
    intervalMs: z.number().int().positive().optional(),
    readMemoryRssMb: z.custom<() => number>((value) => typeof value === "function").optional(),
    nowMs: z.custom<() => number>((value) => typeof value === "function").optional(),
  });
  export type Options = z.infer<typeof Options>;

  export function createSnapshot(input: SnapshotInput): WorkerBootstrap.WorkerSnapshot {
    const { activeRunIds, configEpoch, memoryRssMb, lastHeartbeat } = SnapshotInput.parse(input);
    return {
      activeRuns: activeRunIds,
      backgroundTasks: [],
      lastHeartbeat,
      memoryRss: memoryRssMb,
      configEpoch,
    };
  }

  export async function send(options: Options): Promise<void> {
    await sendParsed(Options.parse(options));
  }

  export function start(options: Options): ReturnType<typeof setInterval> {
    const parsed = Options.parse(options);
    return setInterval(() => {
      void sendParsed(parsed);
    }, parsed.intervalMs ?? DEFAULT_INTERVAL_MS);
  }
}

async function sendParsed(options: WorkerHeartbeat.Options): Promise<void> {
  const {
    workerId,
    ipcAuthToken,
    server,
    getActiveRunIds,
    getConfigEpoch,
    readMemoryRssMb = defaultMemoryRssMb,
    nowMs = Date.now,
  } = options;
  const activeRunIds = getActiveRunIds();
  const memoryRssMb = readMemoryRssMb();
  const snapshot = WorkerHeartbeat.createSnapshot({
    activeRunIds,
    lastHeartbeat: nowMs(),
    memoryRssMb,
    configEpoch: getConfigEpoch(),
  });

  await server
    .call("worker.heartbeat", {
      workerId,
      authToken: ipcAuthToken,
      activeRunIds,
      memoryRssMb,
      snapshot,
    })
    .catch(() => {
      // heartbeat failure is non-fatal; supervisor may not be connected yet
    });
}

function defaultMemoryRssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}
