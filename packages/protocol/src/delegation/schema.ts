import { z } from "zod";

/**
 * Where delegated work goes (docs/machines-and-delegation.md §3).
 * `core` spawns an internal loop; `actor` messages an already-registered
 * external actor. The address says WHO — never HOW it is transported: the
 * kernel resolves the lane (`Handle.lane`) from the address at admission.
 */
export const WorkerAddress = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("core"),
      /** inline = same-context child loop; independent = isolated session/process. */
      scope: z.enum(["inline", "independent"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("actor"),
      actorId: z.string().min(1),
    })
    .strict(),
]);
export type WorkerAddress = z.infer<typeof WorkerAddress>;

/**
 * ask = a question; the reply settles it. assign = commissioned work held to
 * acceptance criteria. Core addresses take both; actor addresses take assign
 * only — the system cannot force an external actor to answer a question, it
 * can only hold commissioned work to its contract.
 */
export const Mode = z.enum(["ask", "assign"]);
export type Mode = z.infer<typeof Mode>;

/** The four delegation transports a kernel driver can resolve an address onto. */
export const Lane = z.enum(["inline", "process", "machine", "channel"]);
export type Lane = z.infer<typeof Lane>;

export const Request = z
  .object({
    address: WorkerAddress,
    mode: Mode,
    payload: z.object({ text: z.string().min(1) }).strict(),
    acceptanceCriteria: z.array(z.string().min(1)).optional(),
    /** Epoch ms. Required: no unbounded delegation exists (kernel-contract Wait law). */
    deadline: z.number().int().positive(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.address.kind === "actor" && request.mode === "ask") {
      ctx.addIssue({
        code: "custom",
        message: "actor addresses accept assign only",
        path: ["mode"],
      });
    }
    if (request.mode === "assign" && (request.acceptanceCriteria?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "assign requires at least one acceptance criterion",
        path: ["acceptanceCriteria"],
      });
    }
    if (request.mode === "ask" && request.acceptanceCriteria !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "ask carries no acceptance criteria",
        path: ["acceptanceCriteria"],
      });
    }
  });
export type Request = z.infer<typeof Request>;

/**
 * What the requester holds after admission: the resolved lane plus the
 * durable ids the settlement will arrive under. Never the worker's state —
 * progress is observed through Wait/WorkItem, not polled through the handle.
 */
export const Handle = z
  .object({
    delegationId: z.string().min(1),
    address: WorkerAddress,
    lane: Lane,
    waitId: z.string().min(1).optional(),
    workItemId: z.string().min(1).optional(),
  })
  .strict();
export type Handle = z.infer<typeof Handle>;

/**
 * Terminal settlement. `delivery_failed` (the request never reached the
 * worker) and `no_response` (delivered, then silence past the deadline) are
 * DISTINCT terminals: unknown-outcome must never be read as did-not-happen.
 */
export const Settled = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      delegationId: z.string().min(1),
      output: z.string(),
      at: z.number(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      delegationId: z.string().min(1),
      error: z.string().min(1),
      at: z.number(),
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      delegationId: z.string().min(1),
      reason: z.string().min(1),
      at: z.number(),
    })
    .strict(),
  z
    .object({
      status: z.literal("delivery_failed"),
      delegationId: z.string().min(1),
      reason: z.string().min(1),
      at: z.number(),
    })
    .strict(),
  z
    .object({
      status: z.literal("no_response"),
      delegationId: z.string().min(1),
      /** The deadline (epoch ms) whose expiry produced this terminal. */
      deadline: z.number().int().positive(),
      at: z.number(),
    })
    .strict(),
]);
export type Settled = z.infer<typeof Settled>;

export const SettledStatus = z.enum([
  "completed",
  "failed",
  "cancelled",
  "delivery_failed",
  "no_response",
]);
export type SettledStatus = z.infer<typeof SettledStatus>;
