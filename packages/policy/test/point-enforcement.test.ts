import { KERNEL_POLICY_REGISTRY } from "../src/named-registry";
import { describe, expect, it, mock } from "bun:test";
import {
  compilePolicySnapshot,
  createPolicyCompiler,
  PolicyCompileError,
  SEEDED_POLICY_ROWS,
  type PolicyEvaluationInput,
} from "../src/index";
import type { PolicyRow, Storage } from "@openomni/protocol";
import { PolicyGenerationRefused } from "../../ledger/src/errors";
import { atGeneration, compaction, draft, MemoryPolicyRows, withPolicyRows, type PolicyRowDraft } from "./row-fixtures";

const input: PolicyEvaluationInput = {
  kind: "tool",
  phase: "pre",
  op: "write",
  role: "resident",
  sessionId: "session-1",
  value: { path: "/tmp/result" },
};

function catchCompile(run: () => void): PolicyCompileError {
  try {
    run();
  } catch (error) {
    expect(PolicyCompileError.isInstance(error)).toBe(true);
    if (PolicyCompileError.isInstance(error)) return error;
  }
  throw new Error("expected policy compile failure");
}

const detachedPolicyCompileErrorGuard = PolicyCompileError.isInstance;

function preservesPolicyCompileErrorNarrowing(error: unknown): PolicyCompileError | undefined {
  if (detachedPolicyCompileErrorGuard(error)) {
    return error;
  }
  return undefined;
}

function catchAppend(run: () => number): PolicyGenerationRefused {
  try {
    run();
  } catch (error) {
    if (error instanceof PolicyGenerationRefused) return error;
    throw error;
  }
  throw new Error("expected append failure");
}

describe("policy row compiler enforcement", () => {
  it("narrows detached guards to PolicyCompileError", () => {
    const error = new PolicyCompileError({ code: "snapshot_load_failed", generation: 1 });
    expect(preservesPolicyCompileErrorNarrowing(error)?.code).toBe("snapshot_load_failed");
  });

  it("cannot disable the mandatory rule and fails closed with exact fields", () => {
    const error = catchCompile(() =>
      compilePolicySnapshot({
        registry: KERNEL_POLICY_REGISTRY,
        generation: 1,
        rows: [],
        mandatory: [],
      }),
    );

    expect(error.toObject()).toEqual({
      name: "PolicyCompileError",
      data: {
        code: "mandatory_rule_missing",
        generation: 1,
        ruleName: "compaction",
        message: "policy generation 1 is missing mandatory rule compaction",
      },
    });
  });

  it("turns storage load failure into a typed deny and never invokes a body", () => {
    const source: MemoryPolicyRows = new MemoryPolicyRows();
    source.rows = () => {
      throw new Error("database unavailable");
    };
    const compiler = createPolicyCompiler({
      registry: KERNEL_POLICY_REGISTRY,
      source,
      mandatory: ["compaction"],
    });
    const evaluator = compiler.pin(9);
    const body = mock(() => "must not run");
    const decision = evaluator.evaluate(input);
    if (decision.verdict === "allow") body();

    expect(body).toHaveBeenCalledTimes(0);
    expect(decision).toMatchObject({
      generation: 9,
      verdict: "deny",
      matchedRuleIds: [],
      reason: "snapshot_load_failed",
      error: {
        code: "snapshot_load_failed",
        generation: 9,
      },
    });
  });

  it.each([
    ["kind", draft("bad-kind", "extension.unregistered", "pre", { type: "allow" }), "unknown_kind"],
    [
      "transformer",
      draft("bad-transform", "tool", "post", { type: "transform", ref: "demo/not-registered" }),
      "unknown_ref",
    ],
    [
      "obligation",
      draft("bad-obligation", "tool", "pre", {
        type: "obligation",
        ref: "demo/not-registered",
        metric: "fanout",
        limit: 2,
      }),
      "unknown_ref",
    ],
  ] as const)("rejects an unregistered %s with exact machine fields", (_label: string, badRow: PolicyRowDraft, code: PolicyCompileError["code"]) => {
    const error = catchCompile(() =>
      compilePolicySnapshot({
        registry: KERNEL_POLICY_REGISTRY,
        generation: 1,
        rows: [atGeneration(compaction, 1), atGeneration(badRow, 1)],
        mandatory: ["compaction"],
      }),
    );

    expect(error.code).toBe(code);
    expect(error.generation).toBe(1);
    expect(error.ruleName).toBe(badRow.name);
  });

  it.each([
    ["generation_mismatch", atGeneration(compaction, 2)],
    [
      "invalid_match",
      atGeneration(draft("bad-match", "tool", "pre", { type: "allow" }, { match: { op: "" } }), 1),
    ],
    [
      "invalid_verdict",
      atGeneration(draft("bad-verdict", "tool", "pre", { type: "unexpected" }), 1),
    ],
  ] as const)("rejects malformed rows with %s", (code: PolicyCompileError["code"], badRow: PolicyRow.Row) => {
    const error = catchCompile(() =>
      compilePolicySnapshot({
        registry: KERNEL_POLICY_REGISTRY,
        generation: 1,
        rows: [atGeneration(compaction, 1), badRow],
        mandatory: ["compaction"],
      }),
    );

    expect(error.code).toBe(code);
  });

  it("requires approval before lower-priority rules can allow", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft(
            "approval",
            "tool",
            "pre",
            {
              type: "require_approval",
              reason: "operator",
            },
            { priority: 100 },
          ),
          1,
        ),
        atGeneration(draft("allow-after", "tool", "pre", { type: "allow" }), 1),
      ],
    });

    expect(snapshot.evaluate(input)).toMatchObject({
      verdict: "require_approval",
      matchedRuleIds: ["approval"],
      reason: "operator",
    });
  });

  it("skips redaction paths that traverse non-objects", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("redact", "tool", "post", {
            type: "transform",
            ref: "kernel/redact",
            config: {
              paths: ["secret.token.value", "list.token.value", "missing.token"],
            },
          }),
          1,
        ),
      ],
    });

    expect(
      snapshot.evaluate({ ...input, phase: "post", value: { secret: null, list: [] } }).value,
    ).toEqual({
      secret: null,
      list: [],
    });
  });

  it("rolls back the entire generation on a conflicting row with typed identity", () => withPolicyRows((source: Storage.PolicyRowSubAdapter) => {
    source.appendGeneration(() => [compaction]);
    const before = source.rows();
    const error = catchAppend(() => source.appendGeneration(() => [compaction, compaction]));
    expect(error).toMatchObject({
      _tag: "PolicyGenerationRefused", reason: "conflict", generation: 2, ruleName: "compaction",
    });
    expect(source.rows()).toEqual(before);
    expect(source.appendGeneration(() => [compaction])).toBe(2);
  }));

  it("refuses empty generations and leaves no durable or cached partial snapshot", () => withPolicyRows((source: Storage.PolicyRowSubAdapter) => {
    const error = catchAppend(() => source.appendGeneration(() => []));
    expect(error).toMatchObject({ _tag: "PolicyGenerationRefused", reason: "empty", generation: 1 });
    expect(source.rows()).toEqual([]);
    expect(source.appendGeneration(() => [compaction])).toBe(1);
    const compiler = createPolicyCompiler({ registry: KERNEL_POLICY_REGISTRY, source });
    expect(compiler.pin(1).evaluate(input).verdict).toBe("allow");
    expect(source.appendGeneration(() => undefined)).toBe(1);
  }));

  it("ships every kernel limit as seeded policy data", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: SEEDED_POLICY_ROWS.map((row: PolicyRowDraft) => atGeneration(row, 1)),
    });
    const cases = [
      ["turn", "post", "continue", "continuation", 8],
      ["tool", "pre", "send_message", "fanout", 8],
      ["turn", "post", "exact_repeat", "exact_repeat", 3],
      ["turn", "post", "toolless_stall", "toolless_stall", 3],
      ["turn", "post", "blocked_recurrence", "blocked_recurrence", 3],
      ["turn", "pre", "resume", "resume", 10],
    ] as const;

    for (const [kind, phase, op, metric, limit] of cases) {
      expect(snapshot.evaluate({ ...input, kind, phase, op }).obligations).toEqual([
        { ref: "kernel/budget-clamp", metric, limit },
      ]);
    }
  });

  it("runs the named redactor only at complete object paths", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("redact-token", "tool", "post", {
            type: "transform",
            ref: "kernel/redact",
            config: {
              paths: ["secret.token", "missing.token"],
              replacement: "[redacted]",
            },
          }),
          1,
        ),
      ],
    });

    expect(
      snapshot.evaluate({
        ...input,
        phase: "post",
        value: { token: "keep", secret: { token: "remove" } },
      }),
    ).toMatchObject({
      verdict: "transform",
      matchedRuleIds: ["redact-token"],
      value: { token: "keep", secret: { token: "[redacted]" } },
    });
  });

  it("orders by descending priority and deny short-circuits lower rules", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      mandatory: ["compaction"],
      rows: [
        atGeneration(compaction, 1),
        atGeneration(draft("low-allow", "tool", "pre", { type: "allow" }, { priority: 10 }), 1),
        atGeneration(draft("highest-allow", "tool", "pre", { type: "allow" }, { priority: 30 }), 1),
        atGeneration(
          draft(
            "middle-deny",
            "tool",
            "pre",
            { type: "deny", reason: "blocked" },
            { priority: 20 },
          ),
          1,
        ),
      ],
    });

    expect(snapshot.evaluate(input)).toMatchObject({
      verdict: "deny",
      matchedRuleIds: ["highest-allow", "middle-deny"],
      evaluatedRuleCount: 2,
      reason: "blocked",
    });
  });

  it("matches op-specific and wildcard rows in one deterministic priority stage", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      mandatory: ["compaction"],
      rows: [
        atGeneration(compaction, 1),
        atGeneration(draft("wildcard", "tool", "pre", { type: "allow" }, { priority: 20 }), 1),
        atGeneration(
          draft(
            "write-only",
            "tool",
            "pre",
            { type: "deny" },
            { match: { op: "write" }, priority: 10 },
          ),
          1,
        ),
      ],
    });

    expect(snapshot.evaluate(input).matchedRuleIds).toEqual(["wildcard", "write-only"]);
    expect(snapshot.evaluate({ ...input, op: "read" }).matchedRuleIds).toEqual(["wildcard"]);
  });

  it("scopes a row to one inner operation of a multi-operation tool", () => {
    const snapshot = compilePolicySnapshot({
      registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft(
            "promote-consent",
            "tool",
            "pre",
            { type: "require_approval", reason: "owner consent" },
            { match: { op: "provision", operation: "contact_promote" }, priority: 10 },
          ),
          1,
        ),
      ],
    });
    const provision = (op: string) => ({
      ...input,
      op: "provision",
      value: { operation: { op, args: {} } },
    });

    expect(snapshot.evaluate(provision("contact_promote"))).toMatchObject({
      verdict: "require_approval",
      reason: "owner consent",
      matchedRuleIds: ["promote-consent"],
    });
    expect(snapshot.evaluate(provision("status"))).toMatchObject({
      verdict: "allow",
      matchedRuleIds: [],
    });
    expect(snapshot.evaluate({ ...input, op: "provision", value: [] }).verdict).toBe("allow");
  });
});
