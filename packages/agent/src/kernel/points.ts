import {
  CAPABILITY_POINT_RECORDS,
  CORE_POINT_RECORDS,
  ComposeRejectionCode,
  NamedError,
  type PointId,
  type PointRecord,
} from "@openomni/protocol";
import { z } from "zod";

/**
 * Merged core+capability point registration table (#1251). The core always
 * registers its eight records; each capability (removable built-in plugin:
 * tool, compaction, alarm, action) registers its own points through its
 * declaration, so a capability point is only present while its owner is
 * composed. Rows compile against this table and reject fail-closed.
 */
export type GatePointTable = ReadonlyMap<string, PointRecord>;

export const GateComposeError = NamedError.create(
  "GateComposeError",
  z
    .object({
      code: ComposeRejectionCode,
      point: z.string().optional(),
      ref: z.string().optional(),
      rowId: z.string().optional(),
      bundle: z.string().optional(),
    })
    .strict(),
);
export type GateComposeError = InstanceType<typeof GateComposeError>;

export interface CapabilityPointRegistration {
  readonly bundle: string;
  readonly points: readonly PointId[];
}

export interface ComposePointTableOptions {
  readonly capabilities: readonly CapabilityPointRegistration[];
  /** The core's own registrations; injected by the core, sealed to the eight records. */
  readonly core?: readonly PointRecord[];
}

const capabilityRecords = new Map(CAPABILITY_POINT_RECORDS.map((record) => [record.id, record]));

/**
 * Builds the merged registration table. Rejections are fail-closed and typed:
 * a missing sealed core record is `builtin_removed`; a capability registering
 * a core-owned or already-registered point is `duplicate`; a registration for
 * an id without a capability record is `unknown_point` (new points require a
 * record).
 */
export function composePointTable(options: ComposePointTableOptions): GatePointTable {
  const core = options.core ?? CORE_POINT_RECORDS;
  for (const sealed of CORE_POINT_RECORDS) {
    if (!core.some((record) => record.id === sealed.id))
      throw new GateComposeError({ code: "builtin_removed", point: sealed.id });
  }
  const table = new Map<string, PointRecord>(core.map((record) => [record.id, record]));
  for (const capability of options.capabilities) {
    for (const id of capability.points) {
      const record = capabilityRecords.get(id);
      if (record === undefined)
        throw new GateComposeError({ code: "unknown_point", point: id, bundle: capability.bundle });
      if (table.has(id))
        throw new GateComposeError({ code: "duplicate", point: id, bundle: capability.bundle });
      table.set(id, record);
    }
  }
  return table;
}

/** The built-in capability registrations the kernel composes by default. */
export const KERNEL_CAPABILITY_POINTS: readonly CapabilityPointRegistration[] = Object.freeze([
  Object.freeze({ bundle: "tool", points: Object.freeze(["tool.pre", "tool.post"] as const) }),
  Object.freeze({
    bundle: "compaction",
    points: Object.freeze(["compaction.pre", "compaction.post"] as const),
  }),
  Object.freeze({ bundle: "alarm", points: Object.freeze(["alarm.fired"] as const) }),
  Object.freeze({ bundle: "action", points: Object.freeze(["action.pre"] as const) }),
]);

export const KERNEL_POINT_TABLE: GatePointTable = composePointTable({
  capabilities: KERNEL_CAPABILITY_POINTS,
});

/**
 * Registry lookup replacing the executor's point calculation (#1251): an
 * execution of `kind` consults `<kind>.<phase>` only when that point is
 * registered; an unregistered pre point fails closed and an unregistered post
 * point is simply not consulted (prompt and message have no post point).
 */
export function executionPoint(
  kind: string,
  phase: "pre" | "post",
  table: GatePointTable = KERNEL_POINT_TABLE,
): PointRecord | undefined {
  return table.get(`${kind}.${phase}`);
}
