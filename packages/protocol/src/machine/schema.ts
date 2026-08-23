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
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
    message: "capability id must be dot-namespaced lowercase (e.g. fs.read)",
  });
export type CapabilityId = z.infer<typeof CapabilityId>;

export const MachineId = z.string().min(1);
export type MachineId = z.infer<typeof MachineId>;

function uniqueCapabilities(capabilities: string[], ctx: z.RefinementCtx): void {
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
