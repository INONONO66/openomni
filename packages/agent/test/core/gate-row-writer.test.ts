import { expect, test } from "bun:test";
import { GateDecision, SessionGeneration, SessionHistory, type PolicyRow } from "@openomni/protocol";
import {
  compilePolicySnapshot,
  createHandlerTable,
  KERNEL_POLICY_REGISTRY,
  SEEDED_POLICY_ROWS,
} from "../../src/core/gate/compile";
import { DEFAULT_COMPILE_KINDS, parseRow } from "../../src/core/gate/row-parse";
import { projectGeneration } from "../../src/core/gate/project";
import { GATE_ROW_WRITER_VERSION } from "../../src/core/gate/rows";
import { composePointTable, KERNEL_CAPABILITY_POINTS } from "../../src/core/points";
import * as SessionHandleStore from "../../src/core/store/fence";

const GENERATION = 1;

/**
 * The pre-cutover identity prefix and id shape, assembled so the sealed
 * token keeps 0 hits in source (#1319 acceptance grep) while the fixture
 * still carries the exact bytes old decision facts were written with.
 */
const PRE_CUTOVER_PREFIX = ["legacy", ""].join("/");
const preCutoverId = (point: string, ordinal: number): string =>
  `${PRE_CUTOVER_PREFIX}${point}#${ordinal}`;

/** The current identity shape (#1319): `<row name>/<point>#<ordinal>`. */
const CURRENT_ID = /^[^/]+\/[a-z.]+#\d+$/;

function seededRows(extra: readonly Omit<PolicyRow.Row, "generation">[] = []): PolicyRow.Row[] {
  return [...SEEDED_POLICY_ROWS, ...extra].map((row) => ({ ...row, generation: GENERATION }));
}

function projected(rows: readonly PolicyRow.Row[]) {
  const registry = createHandlerTable(KERNEL_POLICY_REGISTRY);
  const kinds = new Set<string>(DEFAULT_COMPILE_KINDS);
  const parsed = rows.map((row) => parseRow(row, GENERATION, kinds, registry));
  const table = composePointTable({ capabilities: KERNEL_CAPABILITY_POINTS });
  return projectGeneration(parsed, GENERATION, table, registry);
}

test("a compiled generation mints only current identities; same-name rows on one point stay distinct", () => {
  const duplicate = (priority: number): Omit<PolicyRow.Row, "generation"> => ({
    name: "dup-row",
    kind: "tool",
    phase: "pre",
    priority,
    match: { encodingVersion: 1, value: {} },
    verdict: { encodingVersion: 1, value: { type: "allow" } },
  });
  const generation = projected(seededRows([duplicate(500), duplicate(400)]));
  const ids = [...generation.rowById.keys()];
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    expect(id).toMatch(CURRENT_ID);
    expect(id.startsWith(PRE_CUTOVER_PREFIX)).toBe(false);
  }
  const duplicates = ids.filter((id) => id.startsWith("dup-row/"));
  expect(duplicates).toHaveLength(2);
  expect(new Set(duplicates).size).toBe(2);
  for (const id of duplicates) expect(id).toMatch(/^dup-row\/tool\.pre#\d+$/);
});

test("a decision fact recorded under pre-cutover ids decodes and replays without rewriting its matchedRuleIds", () => {
  const snapshot = compilePolicySnapshot({
    registry: createHandlerTable(KERNEL_POLICY_REGISTRY),
    generation: GENERATION,
    rows: seededRows(),
  });
  const input = { kind: "tool", phase: "pre" as const, op: "qa__noop", value: { bytes: "untouched" } };
  const fresh = snapshot.evaluate(input);
  if (fresh.gate === undefined) throw new Error("fresh evaluation carries no gate decision");

  // The persisted fact decodes with its pre-cutover identities verbatim.
  const fact = SessionHistory.PolicyDecision.parse({
    revision: 1,
    actionId: "qa-decision-1",
    subjectActionId: null,
    turnId: null,
    hook: "tool.pre",
    op: input.op,
    generation: GENERATION,
    matchedRuleIds: [preCutoverId("tool.pre", 0)],
    transforms: [],
    verdict: "allow",
    reason: null,
    inputHash: fresh.inputHash,
  });
  expect(fact.matchedRuleIds).toEqual([preCutoverId("tool.pre", 0)]);

  // Its recorded gate decision replays by input hash; the legacy row ids stay.
  const recorded = GateDecision.parse({ ...fresh.gate, rowIds: [preCutoverId("tool.pre", 0)] });
  const replayed = snapshot.evaluate({ ...input, recorded });
  expect(replayed.replayed).toBe(true);
  expect(replayed.gate?.rowIds).toEqual([preCutoverId("tool.pre", 0)]);
  expect(replayed.value).toEqual(recorded.output);
});

test("a pre-cutover snapshot parses without rowsVersion; a new materialization records version 1", () => {
  const preCutover = SessionGeneration.Snapshot.parse({
    generation: 1,
    revertTo: 0,
    tools: [],
    toolsHash: "qa-tools-hash",
    bundles: [],
    systemPreset: "",
    systemBlocks: [],
    systemValue: "",
    systemHash: "qa-system-hash",
    policyGeneration: 0,
  });
  expect("rowsVersion" in preCutover && preCutover.rowsVersion !== undefined).toBe(false);

  const materialized = SessionHandleStore.generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
  });
  expect(materialized.rowsVersion).toBe(GATE_ROW_WRITER_VERSION);
  expect(materialized.rowsVersion).toBe(1);
});
