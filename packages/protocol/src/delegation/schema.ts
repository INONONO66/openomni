import { z } from "zod";
import { EpochMs } from "../time.js";

/**
 * Where delegated work goes (docs/machines-and-delegation.md §3).
 * `core` spawns an internal loop; `actor` messages an already-registered
 * external actor. The address says WHO — never HOW it is transported: the
 * kernel resolves the transport (`Handle.transport`) from the address at
 * admission.
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
 * What the requester wants from the address (replaces the v1 Mode ask|assign):
 * - notify: fire-and-forget message; no Wait, no reply expected, terminal
 *   `sent` at transport acceptance. Actor addresses only — a core loop exists
 *   to be talked WITH, not AT.
 * - ask: a question; the reply settles it. Core (inline|independent) or actor.
 * - assign: commissioned work held to acceptance criteria. Core independent or
 *   actor — never inline: an inline child is a volatile in-turn helper that
 *   dies with the turn, too weak to hold a contract to.
 */
export const Operation = z.enum(["notify", "ask", "assign"]);
export type Operation = z.infer<typeof Operation>;

/**
 * The three delegation transports a kernel driver can resolve an address
 * onto. Distinct from the core-model "Lane" noun (Built-in/Action/Worker/
 * Subagent execution lanes) — this is the wire, not the role.
 */
export const Transport = z.enum(["inline", "process", "channel"]);
export type Transport = z.infer<typeof Transport>;

export const Request = z
  .object({
    address: WorkerAddress,
    operation: Operation,
    payload: z.object({ text: z.string().min(1) }).strict(),
    acceptanceCriteria: z.array(z.string().min(1)).optional(),
    /** Epoch ms. Required: no unbounded delegation exists (kernel-contract Wait law). */
    deadline: EpochMs.int().positive(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.operation === "notify" && request.address.kind !== "actor") {
      ctx.addIssue({
        code: "custom",
        message: "notify reaches actor addresses only",
        path: ["operation"],
      });
    }
    if (
      request.operation === "assign" &&
      request.address.kind === "core" &&
      request.address.scope === "inline"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "assign never runs inline; inline is a volatile in-turn helper for ask only",
        path: ["address"],
      });
    }
    if (
      request.operation === "assign" &&
      (request.acceptanceCriteria?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "assign requires at least one acceptance criterion",
        path: ["acceptanceCriteria"],
      });
    }
    if (request.operation !== "assign" && request.acceptanceCriteria !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${request.operation} carries no acceptance criteria`,
        path: ["acceptanceCriteria"],
      });
    }
  });
export type Request = z.infer<typeof Request>;

/**
 * Who is asking for work to be delegated, with the lineage the durable
 * lifecycle needs: `parentDelegationId` is the delegation whose turn
 * commissioned this one (absent at the tree root), `rootDelegationId`
 * anchors the per-tree fanout cap count. Both are absent for a root origin
 * and stamped by the admission fold for a child — never self-reported.
 */
export const Origin = z
  .object({
    role: z.enum(["resident", "worker"]),
    /** How many inline children already stand between the Resident and this originator. */
    depth: z.number().int().nonnegative(),
    /**
     * The durable session this delegation chain originates from — the owner
     * of any Wait a transport opens on its behalf. Inherited unchanged down
     * the chain: a child works FOR that session, it does not get its own claim.
     */
    sessionId: z.string().min(1),
    parentDelegationId: z.string().min(1).optional(),
    rootDelegationId: z.string().min(1).optional(),
  })
  .strict();
export type Origin = z.infer<typeof Origin>;

/**
 * What the requester holds after DURABLE admission, before the work runs:
 * the operation, the resolved transport, the effective deadline (admission
 * clamps the requested deadline to the parent's when a parent exists), and
 * the tree ids the settlement will arrive under. Never the worker's state —
 * progress is observed through Wait/WorkItem, not polled through the handle.
 */
export const Handle = z
  .object({
    delegationId: z.string().min(1),
    operation: Operation,
    address: WorkerAddress,
    transport: Transport,
    /** Effective deadline (epoch ms): min(requested, parentDeadline) computed at admission. */
    deadline: EpochMs.int().positive(),
    waitId: z.string().min(1).optional(),
    workItemId: z.string().min(1).optional(),
    parentDelegationId: z.string().min(1).optional(),
    /** Every delegation names its tree root; a root delegation names itself. */
    rootDelegationId: z.string().min(1),
  })
  .strict();
export type Handle = z.infer<typeof Handle>;

/**
 * Terminal settlement. `delivery_failed` (the request never reached the
 * worker) and `no_response` (delivered, then silence past the deadline) are
 * DISTINCT terminals: unknown-outcome must never be read as did-not-happen.
 *
 * `completed` means the worker/actor REPORTED completion (or replied) —
 * nothing more. Acceptance-criteria enforcement is deliberately OUT of this
 * terminal; completion authority over assigned work is a future WorkItem
 * integration, not a schema claim.
 *
 * `interrupted` is set only by the boot sweep: the host restarted while
 * volatile (inline/process) transport work was still open.
 *
 * `sent` is transport acceptance of a notify — terminal for notify only.
 * That rule is pinned where operation meets settlement (`Record`), because
 * a bare terminal carries no operation to check itself against.
 */
const SettledUnion = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      delegationId: z.string().min(1),
      workerRunId: z.string().min(1).optional(),
      output: z.string(),
      at: EpochMs,
      /** Transport-reported spend; visibility only, never an admission input. */
      usage: z.object({ tokens: z.number().int().nonnegative() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      delegationId: z.string().min(1),
      workerRunId: z.string().min(1).optional(),
      error: z.string().min(1),
      at: EpochMs,
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      delegationId: z.string().min(1),
      workerRunId: z.string().min(1).optional(),
      reason: z.string().min(1),
      at: EpochMs,
    })
    .strict(),
  z
    .object({
      status: z.literal("delivery_failed"),
      delegationId: z.string().min(1),
      workerRunId: z.string().min(1).optional(),
      reason: z.string().min(1),
      at: EpochMs,
    })
    .strict(),
  z
    .object({
      status: z.literal("no_response"),
      delegationId: z.string().min(1),
      workerRunId: z.string().min(1).optional(),
      /** The deadline (epoch ms) whose expiry produced this terminal. */
      deadline: EpochMs.int().positive(),
      at: EpochMs,
    })
    .strict(),
  z
    .object({
      status: z.literal("interrupted"),
      delegationId: z.string().min(1),
      workerRunId: z.string().min(1).optional(),
      at: EpochMs,
    })
    .strict(),
  z
    .object({
      status: z.literal("sent"),
      delegationId: z.string().min(1),
      at: EpochMs,
    })
    .strict(),
]);

export const Settled = SettledUnion.superRefine((settled, ctx) => {
  if (settled.status === "no_response" && settled.at < settled.deadline) {
    ctx.addIssue({
      code: "custom",
      message: "no_response cannot settle before its deadline",
      path: ["at"],
    });
  }
});
export type Settled = z.infer<typeof Settled>;

// Derived from the union discriminants so the status vocabulary cannot
// drift from the settled shapes.
export const SettledStatus = z.enum(
  SettledUnion.options.map((option) => option.shape.status.value) as [
    Settled["status"],
    ...Settled["status"][],
  ],
);
export type SettledStatus = z.infer<typeof SettledStatus>;

/**
 * The durable delegation row (record-before-act): the Handle fields plus the
 * origin, an instruction summary, and the open|settled lifecycle. Written at
 * admission BEFORE the work runs, settled exactly once by the kernel's
 * open->settled compare-and-swap. Protocol owns the serializable shape; the
 * store implementation lives in the ledger.
 */
const RecordBase = Handle.extend({
  origin: Origin,
  /** Summary of the request payload text (truncation is the writer's choice). */
  instruction: z.string().min(1),
  status: z.enum(["open", "settled"]),
  settled: Settled.optional(),
  createdAt: EpochMs,
  settledAt: EpochMs.optional(),
  /** Receipt written only after the owner-session settlement wake succeeds. */
  wokenAt: EpochMs.optional(),
}).strict();

export const Record = RecordBase.superRefine((record, ctx) => {
  if (record.status === "settled" && (record.settled === undefined || record.settledAt === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "a settled record carries its settlement payload and settledAt",
      path: ["settled"],
    });
  }
  if (record.status === "open" && (record.settled !== undefined || record.settledAt !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "an open record carries no settlement",
      path: ["settled"],
    });
  }
  if (record.status === "open" && record.wokenAt !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "an open record carries no wake receipt",
      path: ["wokenAt"],
    });
  }
  if (record.settled !== undefined && record.settled.delegationId !== record.delegationId) {
    ctx.addIssue({
      code: "custom",
      message: "settlement payload belongs to a different delegation",
      path: ["settled"],
    });
  }
  if (record.operation === "assign" && record.workItemId === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "an assign record carries the WorkItem it commissioned",
      path: ["workItemId"],
    });
  }
  if (record.operation !== "assign" && record.workItemId !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "only assign commissions a WorkItem",
      path: ["workItemId"],
    });
  }
  if (record.settled?.status === "sent" && record.operation !== "notify") {
    ctx.addIssue({
      code: "custom",
      message: "sent is terminal for notify only",
      path: ["settled", "status"],
    });
  }
});
export type Record = z.infer<typeof Record>;
