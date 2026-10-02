import { describe, expect, it } from "bun:test";
import {
  CAPABILITY_POINT_RECORDS,
  CORE_POINT_RECORDS,
  ComposeRejectionCode,
  EMIT_KINDS,
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

  it("keeps core records core-owned and capability records owned by their capability", () => {
    for (const record of CORE_POINT_RECORDS) expect(record.owner).toBe("core");
    expect(CAPABILITY_POINT_RECORDS.map((record) => [record.id, record.owner])).toEqual([
      ["tool.pre", "tool"],
      ["tool.post", "tool"],
      ["compaction.pre", "compaction"],
      ["compaction.post", "compaction"],
      ["alarm.fired", "alarm"],
      ["action.pre", "action"],
    ]);
  });

  it("marks turn.post as the end point and withholds emit from it", () => {
    const turnPost = POINT_RECORDS.find((record) => record.id === "turn.post");
    expect(turnPost?.end).toBe(true);
    expect(turnPost?.allowedDo).not.toContain("emit");
    for (const record of POINT_RECORDS) {
      if (record.id !== "turn.post") expect(record.end).toBeUndefined();
    }
  });

  it("restricts observe-only points to emit/observe", () => {
    for (const id of ["session.open", "compaction.post", "alarm.fired"] as const) {
      const record = POINT_RECORDS.find((candidate) => candidate.id === id);
      expect(record?.allowedDo).toEqual(["emit", "observe"]);
      expect(record?.rewritableFields).toEqual([]);
    }
  });

  it("allows only message, alarm.arm and compaction emissions", () => {
    expect([...EMIT_KINDS]).toEqual(["message", "alarm.arm", "compaction"]);
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

  it("parses the folded decision with consulted payloads and recorded facts", () => {
    const decision = {
      point: "turn.post" as const,
      verdict: "allow" as const,
      rowIds: ["guard/turn.post#0"],
      obligations: [{ metric: "continuation", limit: 8 }],
      consulted: [{ ref: "guard/limits", digest: "d1", payload: { limit: 8 } }],
      facts: [{ rowId: "guard/turn.post#0", ref: "guard/escape", code: "requirement_escape" }],
      inputHash: "hash-a",
      generation: 3,
    };
    expect(GateDecision.parse(decision)).toEqual(decision);
  });

  it("enumerates the compose rejection codes", () => {
    expect([...ComposeRejectionCode.options]).toEqual([
      "unknown_point",
      "unknown_handler",
      "duplicate",
      "bad_action",
      "bad_field",
      "post_end_emit",
      "builtin_removed",
    ]);
  });
});
