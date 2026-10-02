import type { GateRow, PointId } from "@openomni/protocol";
import {
  composePointTable,
  KERNEL_CAPABILITY_POINTS,
  type GatePointTable,
} from "../../src/kernel/points";

/** The fully composed table: eight core points plus the four built-in capabilities. */
export function fullPointTable(): GatePointTable {
  return composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
}

let sequence = 0;

export function gateRow(on: PointId, overrides: Partial<GateRow> = {}): GateRow {
  sequence += 1;
  return {
    id: `fixture/${on}#${sequence}`,
    on,
    when: {},
    do: "gate",
    how: { verdict: "allow" },
    order: sequence,
    generation: 1,
    ...overrides,
  };
}
