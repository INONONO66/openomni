import { NamedError } from "@openomni/protocol";
import { z } from "zod";

/**
 * Typed rejection taxonomy for the worker driver's `deliver` verb (#462 §4).
 * Callers branch on `data.code`, never on message text.
 *
 * #500 C3: moved here from protocol — the throwers are this package's pool
 * and supervisor, and the only external catcher is the composition root
 * (apps/server execution/coordinator.ts), which depends on coordinator.
 */
export const WorkerDeliveryError = NamedError.create(
  "WorkerDeliveryError",
  z.object({
    message: z.string(),
    code: z.enum([
      "queue_full",
      "shutting_down",
      "duplicate_run",
      "slot_wait_timeout",
      "worker_restarted",
      "session_mismatch",
      "wall_time_exceeded",
      // Supervisor-level rejections (#audit M6): the worker RPCs reject with
      // these instead of untyped Error/raw IpcConnectionError.
      "worker_unavailable",
      "worker_not_ready",
      "worker_stopped",
      "ipc_connection_lost",
    ]),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
);
