import { z } from "zod";

/**
 * Capability id grammar: two-plus dot-separated lowercase segments —
 * `fs.read`, `shell.exec`, `kernel.py`, `screen.read`, `input.write`.
 * The vocabulary is open (drivers introduce ids as they earn them); the
 * GRAMMAR is owned here so the enrollment writer, the daemon's offer, and
 * the tool catalog's `requires` can never drift into three spellings.
 */
export const CapabilityId = z
  .string()
  .max(128, { message: "capability id must be at most 128 characters" })
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
    message: "capability id must be dot-namespaced lowercase (e.g. fs.read)",
  });
export type CapabilityId = z.infer<typeof CapabilityId>;

/** Capability ids whose behavior is defined by the machine protocol. */
export const WellKnownCapability = {
  pythonKernel: "kernel.py",
} as const satisfies Record<string, CapabilityId>;

export const MachineId = z.string().min(1);
export type MachineId = z.infer<typeof MachineId>;

/** One owner for the frozen machine wire method names used by both peers. */
export const WireMethod = {
  Attach: "machine.attach",
  RunCell: "machine.run_cell",
  CallTool: "machine.call_tool",
} as const;

/** Shared by Enrollment/Offer arrays and the machine.attached event payload. */
export function uniqueCapabilities(capabilities: string[], ctx: z.RefinementCtx): void {
  if (new Set(capabilities).size !== capabilities.length) {
    ctx.addIssue({ code: "custom", message: "capabilities must be unique" });
  }
}

/**
 * Owner-side admission record: what this machine is ALLOWED to do.
 * One half of the effective-capability fold (`fold.ts`) — the other half is
 * the daemon's `Offer`. An enrollment with no capability is a contradiction
 * (there would be nothing to attach for), hence `.min(1)`.
 */
export const Enrollment = z
  .object({
    machineId: MachineId,
    name: z.string().min(1),
    allowedCapabilities: z.array(CapabilityId).min(1).superRefine(uniqueCapabilities),
    enrolledAt: z.number(),
  })
  .strict();
export type Enrollment = z.infer<typeof Enrollment>;

/**
 * Daemon-side attach report: what this machine CAN do right now.
 * May be empty — a daemon is allowed to attach before any capability module
 * is ready; it simply yields an empty effective set until it re-offers.
 */
export const Offer = z
  .object({
    machineId: MachineId,
    offeredCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
    daemonVersion: z.string().min(1),
    /** e.g. "darwin-arm64" — display/diagnostic fact, never a matching key. */
    platform: z.string().min(1),
    offeredAt: z.number(),
  })
  .strict();
export type Offer = z.infer<typeof Offer>;

/**
 * Host reply to a daemon's `machine.attach` wire call. `refused` is a typed
 * outcome, not a transport error: the connection stays open and the daemon
 * may re-offer after the Owner fixes the enrollment.
 */
export const AttachResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("attached"),
      effectiveCapabilities: z.array(CapabilityId).superRefine(uniqueCapabilities),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      reason: z.enum(["machine_not_enrolled", "machine_mismatch"]),
    })
    .strict(),
]);
export type AttachResult = z.infer<typeof AttachResult>;

export const CellRequest = z
  .object({
    cellId: z.string().min(1),
    code: z.string(),
    timeoutMs: z.number().int().positive(),
    /**
     * Which tenant's interpreter runs the cell. One attachment can serve
     * several sessions, and a Python interpreter offers no in-process
     * isolation — state, and any thread a cell leaves behind, are reachable
     * by whatever runs in that process next. The daemon therefore keeps one
     * interpreter per tenant so a cell can only ever share a process with
     * cells of the same session. Absent on the wire reads as "default".
     */
    tenant: z.string().min(1).optional(),
  })
  .strict();
export type CellRequest = z.infer<typeof CellRequest>;

const CellOutput = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

/**
 * A `tool.<name>(...)` call made from inside a running cell, travelling back to
 * the host over the same attachment (docs/machines-and-delegation.md §5.5).
 * This is what makes a cell worth more than N tool round trips.
 */
export const ToolCall = z
  .object({
    cellId: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * Two arms because the cell can only do two things with the answer: use the
 * value, or see an exception. A refused tool is a `failed` whose message says
 * so — the host's tool port owns that judgment, not this contract.
 */
export const ToolCallResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), value: z.unknown() }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().min(1) }).strict(),
]);
export type ToolCallResult = z.infer<typeof ToolCallResult>;

/** Honest Python cell terminals: deadline expiry is never collapsed into a raise. */
export const CellResult = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      cellId: z.string().min(1),
      output: CellOutput,
      value: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("raised"),
      cellId: z.string().min(1),
      output: CellOutput,
      error: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("timed_out"),
      cellId: z.string().min(1),
    })
    .strict(),
]);
export type CellResult = z.infer<typeof CellResult>;
