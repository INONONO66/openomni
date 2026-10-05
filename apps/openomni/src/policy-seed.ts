import { Core, type Bundle } from "@openomni/agent";
const SEEDED_POLICY_ROWS = Core.SEEDED_POLICY_ROWS;
const { assertPointGenerationRows, POINT_GENERATION_ROW, translateLegacyPolicyRow } = Core;
import type { PlainValue, PolicyRow, Storage as ProtocolStorage } from "@openomni/protocol";
import { composedPointTable } from "./composition/point-table";
import { AppInvariantError } from "./invariant";
import { MESSAGE_POLICY_ROWS } from "./message-policy";
import { PROVISION_POLICY_ROWS } from "./tools/provision";

/** The live policy plane's legacy `kind`/`phase` address of each #1251 point. */
const LEGACY_ADDRESS_BY_POINT: Readonly<Record<string, { kind: string; phase: PolicyRow.Phase }>> = {
  "ingress.pre": { kind: "inbox.deliver", phase: "pre" },
  "session.open": { kind: "session.configure", phase: "pre" },
  "prompt.pre": { kind: "prompt", phase: "pre" },
  "turn.pre": { kind: "turn", phase: "pre" },
  "turn.post": { kind: "turn", phase: "post" },
  "llm.pre": { kind: "llm", phase: "pre" },
  "llm.post": { kind: "llm", phase: "post" },
  "message.pre": { kind: "message", phase: "pre" },
  "tool.pre": { kind: "tool", phase: "pre" },
  "tool.post": { kind: "tool", phase: "post" },
  "compaction.pre": { kind: "compaction", phase: "pre" },
  "compaction.post": { kind: "compaction", phase: "post" },
  "alarm.fired": { kind: "alarm.fired", phase: "post" },
};

function gateRowVerdict(row: Bundle.BundleGateRow): PlainValue {
  if (row.do === "gate" && row.how.ref !== undefined) {
    if (row.how.metric !== undefined && row.how.limit !== undefined)
      return { type: "obligation", ref: row.how.ref, metric: row.how.metric, limit: row.how.limit };
    // #1258: a consulted gate row (no budget fields) seeds as a guard verdict;
    // the named guard handler decides per input at the point.
    return { type: "guard", ref: row.how.ref, ...(row.how.params === undefined ? {} : { config: row.how.params }) };
  }
  if (row.do === "gate") {
    const verdict = row.how.verdict ?? "allow";
    return verdict === "require_approval" ? { type: verdict, reason: row.id } : { type: verdict };
  }
  if (row.do === "rewrite" && row.how.ref !== undefined)
    return { type: "transform", ref: row.how.ref, ...(row.how.params === undefined ? {} : { config: row.how.params }) };
  throw new AppInvariantError(`gate row ${row.id} (${row.do}) has no live policy-plane seed shape`);
}

/**
 * Projects the composed generation's gate rows (#1255 S2, frozen #1251 shape)
 * onto the legacy rows the live policy plane seeds. The row id stays the
 * durable name, so a recompose re-seeding the same rows is the no-op write
 * `seedKernelPolicyRows` already recognizes.
 */
export function gateRowPolicySeeds(
  rows: readonly Bundle.BundleGateRow[],
): readonly Omit<PolicyRow.Row, "generation">[] {
  return rows.map((row) => {
    const address = LEGACY_ADDRESS_BY_POINT[row.on];
    if (address === undefined)
      throw new AppInvariantError(`gate row ${row.id} targets ${row.on}, which has no legacy policy address`);
    return {
      name: row.id,
      kind: address.kind,
      phase: address.phase,
      priority: row.order,
      match: { encodingVersion: 1 as const, value: { ...row.when } },
      verdict: { encodingVersion: 1 as const, value: gateRowVerdict(row) },
    };
  });
}

/**
 * The kernel's mandatory rows: the agent seed, message routing, provisioning
 * consent. Bundle-owned rows (the monitor wake budget, #1255 P2) arrive
 * through the `bundleRows` argument — the bundle, not the kernel, owns them.
 */
const KERNEL_POLICY_ROWS: readonly Omit<PolicyRow.Row, "generation">[] = [
  ...SEEDED_POLICY_ROWS,
  ...MESSAGE_POLICY_ROWS,
  ...PROVISION_POLICY_ROWS,
  POINT_GENERATION_ROW,
];

/**
 * Seeds the kernel's mandatory generation into the catalog's policy plane and
 * converts the latest generation once into a validated fourteen-point
 * generation (#1251): historical generations keep their exact bytes, and a
 * latest row that cannot map to a registered point rejects the whole write
 * unit, failing the boot.
 */
export function seedKernelPolicyRows(
  policies: ProtocolStorage.PolicyRowSubAdapter,
  bundleRows: readonly Omit<PolicyRow.Row, "generation">[] = [],
  /** The composition's merged point table (#1251); the default is the full built-in composition this app ships. */
  table: Core.GatePointTable = composedPointTable(),
): number {
  return policies.appendGeneration((current) => {
    // Convert the latest generation's semantics onto the fourteen-point
    // contract and validate every row BEFORE any early return: a completed
    // generation carrying an unmappable custom row still rejects the boot.
    const converted = current.map((row) => translateLegacyPolicyRow(row));
    assertPointGenerationRows(converted, table);
    const next = new Map([...KERNEL_POLICY_ROWS, ...bundleRows].map((row) => [policyId(row), row]));
    // Preserve existing policy values and site-specific ids; fill missing mandatory ids.
    for (const row of converted) next.set(policyId(row), row);
    // The rows this boot writes must themselves map onto the composition's
    // points: a composition without a capability refuses its rows at seed.
    assertPointGenerationRows([...next.values()], table);
    // Identity compares the STORED rows: a conversion that changed any row's
    // point identity must land as a new generation even when the converted
    // set already matches the target.
    const storedIds = new Set(current.map(policyId));
    if (storedIds.size === next.size && [...next.keys()].every((id) => storedIds.has(id))) {
      return undefined;
    }
    return [...next.values()];
  });
}

function policyId(row: Omit<PolicyRow.Row, "generation">): string {
  return JSON.stringify([row.name, row.kind, row.phase]);
}
