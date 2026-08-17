import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const Base = z.object({
  traceId: z.string(),
  time: z.number(),
  workerId: z.number(),
});

const RunBase = Base.extend({
  runId: z.string(),
  sessionId: z.string(),
});

/**
 * Structured lifecycle events emitted by the ring-2 worker driver through its
 * injected `BusEvent.Sink` (#462 §4). These are the ledger's record of process
 * physics — worker lifecycle must be reconstructable from these events alone;
 * nothing holds an in-memory map for a reader that doesn't exist. Stall
 * detection is a kernel-level policy over event recency, not a push channel.
 */
export namespace WorkerDriver {
  /** A worker process was spawned (each restart increments `generation`). */
  export const Spawned = BusEvent.define(
    "worker.spawned",
    Base.extend({ generation: z.number() }),
    { visibility: "internal" },
  );

  /** The worker completed IPC bootstrap and can accept deliveries. */
  export const Ready = BusEvent.define("worker.ready", Base.extend({ generation: z.number() }), {
    visibility: "internal",
  });

  /** The worker process exited; `planned` is false for crashes. */
  export const Exited = BusEvent.define(
    "worker.exited",
    Base.extend({ generation: z.number(), planned: z.boolean() }),
    { visibility: "internal" },
  );

  /** A crashed worker was scheduled for restart after `delayMs`. */
  export const Restarted = BusEvent.define(
    "worker.restarted",
    Base.extend({ restartCount: z.number(), delayMs: z.number() }),
    { visibility: "internal" },
  );

  /** A run was handed to a ready worker over IPC. */
  export const RunDelivered = BusEvent.define("run.delivered", RunBase, {
    visibility: "internal",
  });

  /**
   * The delivery concluded at the driver level. `outcome` records process
   * physics only — `completed` means the worker returned a response (the
   * driver never judges run content), `interrupted` means the wall-time
   * ceiling killed the worker, `cancelled` means the caller cancelled the
   * run (before or during delivery; `durationMs` is 0 when the run never
   * reached a worker), `error` is any other delivery failure.
   */
  export const RunSettled = BusEvent.define(
    "run.settled",
    RunBase.extend({
      outcome: z.enum(["completed", "interrupted", "error", "cancelled"]),
      durationMs: z.number(),
    }),
    { visibility: "internal" },
  );

  /** The delivery wait queue hit its bound; the next waiter is rejected. */
  export const QueueSaturated = BusEvent.define(
    "worker.queue_saturated",
    z.object({
      traceId: z.string(),
      time: z.number(),
      queued: z.number(),
      maxQueuedDeliveries: z.number(),
    }),
    { visibility: "internal" },
  );
}
