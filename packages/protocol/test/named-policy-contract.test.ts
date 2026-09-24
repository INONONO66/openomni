import { describe, expect, test } from "bun:test";
import {
  canonicalDigest,
  LedgerAction,
  RowVerdict,
  RowVerdictRead,
  SessionGeneration,
  SessionHistory,
} from "../src/index";

describe("durable named-policy wire contract", () => {
  test("transform rows require namespaced refs and JSON-only config", () => {
    const verdict = {
      type: "transform" as const,
      ref: "demo/redact-home",
      config: { paths: ["home"] },
    };
    expect(RowVerdict.parse(verdict)).toEqual(verdict);
    for (const ref of [undefined, "", "redact", "Demo/redact", "demo/", "demo/a/b"]) {
      expect(RowVerdict.safeParse({ ...verdict, ref }).success).toBe(false);
    }
    for (const config of [() => null, new Date(), { apply: () => null }]) {
      expect(RowVerdict.safeParse({ ...verdict, config }).success).toBe(false);
    }
    expect(RowVerdict.safeParse({ ...verdict, apply: () => null }).success).toBe(false);
    expect(RowVerdict.parse({ type: "transform", ref: "demo/redact-home" })).toEqual({
      type: "transform",
      ref: "demo/redact-home",
    });
  });

  test("one historical decoder preserves raw bytes while canonicalizing known names", () => {
    const old = { type: "transform", name: "redact", paths: ["secret"], replacement: "hidden" };
    const bytes = JSON.stringify(old);
    const hash = canonicalDigest(old);
    expect(RowVerdictRead.parse(old)).toEqual({
      type: "transform",
      ref: "kernel/redact",
      config: { paths: ["secret"], replacement: "hidden" },
    });
    expect(JSON.stringify(old)).toBe(bytes);
    expect(canonicalDigest(old)).toBe(hash);
    expect(RowVerdict.safeParse(old).success).toBe(false);
    expect(RowVerdictRead.parse({ type: "transform", name: "redact" })).toEqual({
      type: "transform",
      ref: "kernel/redact",
      config: { paths: [] },
    });
    expect(
      RowVerdictRead.parse({
        type: "obligation",
        name: "budget_clamp",
        metric: "fanout",
        limit: 8,
      }),
    ).toEqual({ type: "obligation", ref: "kernel/budget-clamp", metric: "fanout", limit: 8 });
    expect(RowVerdictRead.safeParse({ type: "transform", name: "other" }).success).toBe(false);
    expect(RowVerdictRead.safeParse({ ...old, extra: true }).success).toBe(false);
  });

  test("generation identity is session-qualified and bundle selection is a canonical set", () => {
    expect(SessionGeneration.Id.parse({ sessionId: "s1", generation: 1 })).not.toEqual(
      SessionGeneration.Id.parse({ sessionId: "s2", generation: 1 }),
    );
    expect(SessionGeneration.Id.safeParse({ sessionId: "s1", generation: 0 }).success).toBe(false);
    const historic = {
      generation: 1,
      revertTo: 0,
      tools: [],
      toolsHash: "t",
      systemPreset: "",
      systemBlocks: [],
      systemValue: "",
      systemHash: "s",
      policyGeneration: 1,
    };
    const bytes = JSON.stringify(historic);
    expect(SessionGeneration.Snapshot.parse(historic).bundles).toEqual([]);
    expect(JSON.stringify(historic)).toBe(bytes);
    expect(
      SessionGeneration.Snapshot.parse({ ...historic, bundles: ["audit", "demo"] }).bundles,
    ).toEqual(["audit", "demo"]);
    for (const bundles of [["demo", "audit"], ["demo", "demo"], ["bad/name"]]) {
      expect(SessionGeneration.Snapshot.safeParse({ ...historic, bundles }).success).toBe(false);
    }
  });

  test("intent retains original args beside admitted args and inspection retains ordered refs", () => {
    const intent = {
      phase: "intent" as const,
      op: "bash",
      value: { command: "redacted" },
      originalArgs: { command: "secret" },
      callId: "c1",
    };
    expect(LedgerAction.Intent.parse(JSON.parse(JSON.stringify(intent)))).toEqual(intent);
    expect(
      LedgerAction.Intent.parse({ phase: "intent", op: "bash", value: null }),
    ).not.toHaveProperty("originalArgs");
    expect(LedgerAction.Intent.safeParse({ ...intent, originalArgs: () => null }).success).toBe(
      false,
    );
    const decision = {
      revision: 1,
      actionId: "d1",
      subjectActionId: "a1",
      turnId: null,
      hook: "tool.pre",
      op: "bash",
      generation: 1,
      matchedRuleIds: ["redact"],
      verdict: "transform",
      reason: null,
      inputHash: "h",
      transforms: [{ ruleId: "redact", ref: "demo/redact" }],
      ref: "demo/redact",
    };
    expect(SessionHistory.PolicyDecision.parse(decision)).toEqual(decision);
  });
});
