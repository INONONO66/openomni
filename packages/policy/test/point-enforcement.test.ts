import { describe, expect, it, mock } from "bun:test";
import {
  compilePolicySnapshot,
  createPolicyCompiler,
  PolicyCompileError,
  SEEDED_POLICY_ROWS,
  type PolicyEvaluationInput,
} from "../src/index";
import { atGeneration, compaction, draft, MemoryPolicyRows } from "./row-fixtures";

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

describe("policy row compiler enforcement", () => {
  it("cannot disable the mandatory rule and fails closed with exact fields", () => {
    const error = catchCompile(() =>
      compilePolicySnapshot({ generation: 1, rows: [], mandatory: [] }),
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
    const compiler = createPolicyCompiler({ source, mandatory: ["compaction"] });
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
      draft("bad-transform", "tool", "post", { type: "transform", name: "not-registered" }),
      "unknown_transformer",
    ],
    [
      "obligation",
      draft("bad-obligation", "tool", "pre", {
        type: "obligation",
        name: "not-registered",
        limit: 2,
      }),
      "unknown_obligation",
    ],
  ] as const)("rejects an unregistered %s with exact machine fields", (_label, badRow, code) => {
    const error = catchCompile(() =>
      compilePolicySnapshot({
        generation: 1,
        rows: [atGeneration(compaction, 1), atGeneration(badRow, 1)],
        mandatory: ["compaction"],
      }),
    );

    expect(error.code).toBe(code);
    expect(error.generation).toBe(1);
    expect(error.ruleName).toBe(badRow.name);
  });

  it("ships every kernel limit as seeded policy data", () => {
    const snapshot = compilePolicySnapshot({
      generation: 1,
      rows: SEEDED_POLICY_ROWS.map((row) => atGeneration(row, 1)),
    });
    const cases = [
      ["turn", "post", "continue", "continuation", 8],
      ["tool", "pre", "sendMessage", "fanout", 8],
      ["turn", "post", "exact_repeat", "exact_repeat", 3],
      ["turn", "post", "toolless_stall", "toolless_stall", 3],
      ["turn", "post", "blocked_recurrence", "blocked_recurrence", 3],
      ["turn", "pre", "resume", "resume", 10],
    ] as const;

    for (const [kind, phase, op, metric, limit] of cases) {
      expect(snapshot.evaluate({ ...input, kind, phase, op }).obligations).toEqual([
        { name: "budget_clamp", metric, limit },
      ]);
    }
  });

  it("runs the named redactor only at complete object paths", () => {
    const snapshot = compilePolicySnapshot({
      generation: 1,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("redact-token", "tool", "post", {
            type: "transform",
            name: "redact",
            paths: ["secret.token", "missing.token"],
            replacement: "[redacted]",
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
});
