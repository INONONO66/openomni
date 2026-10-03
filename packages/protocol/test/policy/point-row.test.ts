import { describe, expect, it } from "bun:test";
import {
  CAPABILITY_POINT_RECORDS,
  CORE_POINT_RECORDS,
  ComposeRejectionCode,
  GateDecision,
  GateHow,
  GateRow,
  POINT_RECORDS,
  PointId,
  emittedRowKey,
} from "../../src/index";

describe("point registry records (#1251)", () => {
  it("registers exactly fourteen points: eight core and six capability records", () => {
    expect(CORE_POINT_RECORDS).toHaveLength(8);
    expect(CAPABILITY_POINT_RECORDS).toHaveLength(6);
    expect(POINT_RECORDS).toHaveLength(14);
    expect(new Set(POINT_RECORDS.map((record) => record.id)).size).toBe(14);
    expect([...POINT_RECORDS.map((record) => record.id)].sort()).toEqual(
      [...PointId.options].sort(),
    );
  });

  // Consistency invariants over the registry, not transcriptions of it:
  // which records exist and what each allows is covered behaviorally by the
  // gate-row compiler's admission tests.
  it("names every capability record after the capability that owns its point", () => {
    for (const record of CORE_POINT_RECORDS) expect(record.owner).toBe("core");
    for (const record of CAPABILITY_POINT_RECORDS)
      expect(record.id.split(".")[0]).toBe(record.owner);
  });

  it("withholds emit from every end point, and the loop has one", () => {
    const ends = POINT_RECORDS.filter((record) => record.end === true);
    expect(ends.length).toBeGreaterThan(0);
    for (const record of ends) expect(record.allowedDo).not.toContain("emit");
  });


  it("declares nonempty rewritable fields wherever rewrite is an allowed action", () => {
    for (const record of POINT_RECORDS) {
      if (record.allowedDo.includes("rewrite")) expect(record.rewritableFields.length).toBeGreaterThan(0);
      else expect(record.rewritableFields).toEqual([]);
    }
  });
});

describe("gate row contract (#1251)", () => {
  const row = {
    id: "guard/tool.pre#0",
    on: "tool.pre" as const,
    when: { op: "write" },
    do: "gate" as const,
    how: { ref: "guard/write-check" },
    order: 1,
    generation: 3,
  };

  it("parses a consulted gate row and a constant-verdict row", () => {
    expect(GateRow.parse(row)).toEqual(row);
    const constant = { ...row, id: "guard/tool.pre#1", how: { verdict: "deny" as const } };
    expect(GateRow.parse(constant)).toEqual(constant);
  });

  it("rejects malformed ids, unknown points and unknown actions", () => {
    expect(GateRow.safeParse({ ...row, id: "guard-tool-pre" }).success).toBe(false);
    expect(GateRow.safeParse({ ...row, on: "provider.header" }).success).toBe(false);
    expect(GateRow.safeParse({ ...row, do: "transform" }).success).toBe(false);
    expect(GateHow.safeParse({ ref: "guard/write-check", extra: true }).success).toBe(false);
  });

  it("derives a stable emission idempotency key from input hash, row id and index", () => {
    const key = emittedRowKey("hash-a", row.id, 0);
    expect(emittedRowKey("hash-a", row.id, 0)).toBe(key);
    expect(emittedRowKey("hash-a", row.id, 1)).not.toBe(key);
    expect(emittedRowKey("hash-b", row.id, 0)).not.toBe(key);
  });

  it("parses the folded decision with consulted payloads, annotations, output and facts", () => {
    const decision = {
      point: "turn.post" as const,
      verdict: "allow" as const,
      rowIds: ["guard/turn.post#0"],
      obligations: [{ metric: "continuation", limit: 8 }],
      consulted: [{ ref: "guard/limits", digest: "d1", payload: { limit: 8 } }],
      annotations: [{ rowId: "guard/turn.post#0", ref: "guard/audit", payload: { seen: true } }],
      facts: [{ rowId: "guard/turn.post#0", ref: "guard/escape", code: "requirement_escape" }],
      output: { budget: 3 },
      inputHash: "hash-a",
      generation: 3,
    };
    expect(GateDecision.parse(decision)).toEqual(decision);
  });

  it("refuses a decision that omits the replayable rewrite output or annotations", () => {
    const base = {
      point: "turn.post" as const,
      verdict: "allow" as const,
      rowIds: [],
      obligations: [],
      consulted: [],
      annotations: [],
      facts: [],
      output: null,
      inputHash: "hash-a",
      generation: 3,
    };
    expect(GateDecision.parse(base)).toEqual(base);
    const { output: _output, ...withoutOutput } = base;
    expect(GateDecision.safeParse(withoutOutput).success).toBe(false);
    const { annotations: _annotations, ...withoutAnnotations } = base;
    expect(GateDecision.safeParse(withoutAnnotations).success).toBe(false);
  });

  it("refuses foreign or malformed compose rejection codes", () => {
    expect(ComposeRejectionCode.safeParse("unknown_point").success).toBe(true);
    expect(ComposeRejectionCode.safeParse("unknown_kind").success).toBe(false);
    expect(ComposeRejectionCode.safeParse("").success).toBe(false);
  });

  it("parses a declared requires collection and refuses malformed dependency refs", () => {
    const declared = { ref: "guard/write-check", requires: ["guard/helper", "audit/log"] };
    expect(GateHow.parse(declared)).toEqual(declared);
    expect(GateHow.safeParse({ ref: "guard/write-check", requires: ["not a ref"] }).success).toBe(false);
  });
});
