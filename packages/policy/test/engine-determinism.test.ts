import { describe, expect, it } from "bun:test";
import {
  compilePolicySnapshot,
  createPolicyCompiler,
  type PolicyEvaluationInput,
} from "../src/index";
import { atGeneration, compaction, draft, MemoryPolicyRows } from "./row-fixtures";

const request: PolicyEvaluationInput = {
  kind: "tool",
  phase: "pre",
  op: "read",
  role: "resident",
  sessionId: "session-1",
  value: { path: "/workspace/readme.md" },
};

function initialRows() {
  return [
    atGeneration(compaction, 1),
    atGeneration(
      draft("redact-password", "tool", "post", {
        type: "transform",
        name: "redact",
        paths: ["password"],
      }),
      1,
    ),
    atGeneration(
      draft("allow-read", "tool", "pre", { type: "allow" }, { match: { op: "read" } }),
      1,
    ),
  ];
}

describe("compiled policy snapshot determinism", () => {
  it("pins a turn to its generation while copy-on-write append advances new evaluators", async () => {
    const source = new MemoryPolicyRows(initialRows());
    const compiler = createPolicyCompiler({ source, mandatory: ["compaction"] });
    const oldEvaluator = compiler.pin(1);
    const release = Promise.withResolvers<void>();
    const oldTurn = release.promise.then(() => oldEvaluator.evaluate(request));

    const generation = await compiler.append([
      draft(
        "deny-read",
        "tool",
        "pre",
        { type: "deny", reason: "read suspended" },
        { match: { op: "read" }, priority: 2_000 },
      ),
    ]);
    const current = compiler.pin(generation);
    release.resolve();

    expect(generation).toBe(2);
    expect((await oldTurn).verdict).toBe("allow");
    expect(current.evaluate(request)).toMatchObject({
      generation: 2,
      verdict: "deny",
      matchedRuleIds: ["deny-read"],
      reason: "read suspended",
    });
    expect(oldEvaluator.evaluate(request)).toEqual(await oldTurn);
  });

  it("derives the same content hash and result regardless of insertion order", () => {
    const rows = initialRows();
    const forward = compilePolicySnapshot({
      generation: 1,
      rows,
      mandatory: ["compaction"],
    });
    const reverse = compilePolicySnapshot({
      generation: 1,
      rows: [...rows].reverse(),
      mandatory: ["compaction"],
    });

    expect(forward.contentHash).toBe(reverse.contentHash);
    expect(forward.evaluate(request)).toEqual(reverse.evaluate(request));
  });

  it("captures immutable row data without freezing caller-owned rows", () => {
    const rows = initialRows();
    const snapshot = compilePolicySnapshot({
      generation: 1,
      rows,
      mandatory: ["compaction"],
    });
    const before = snapshot.evaluate(request);
    const readRule = rows.find((row) => row.name === "allow-read");
    if (readRule === undefined) throw new Error("missing read rule fixture");

    expect(Object.isFrozen(readRule)).toBe(false);
    readRule.name = "mutated";
    readRule.priority = 10_000;
    readRule.match.value = { op: "write" };

    expect(snapshot.evaluate(request)).toEqual(before);
  });

  it("captures verdict data without aliasing caller-owned nested values", () => {
    const verdict = {
      type: "transform",
      name: "redact",
      paths: ["credentials.password"],
      replacement: "[redacted]",
    };
    const row = draft("redact-credentials", "tool", "post", verdict);
    const snapshot = compilePolicySnapshot({
      generation: 1,
      rows: [atGeneration(compaction, 1), atGeneration(row, 1)],
      mandatory: ["compaction"],
    });
    const requestWithCredentials: PolicyEvaluationInput = {
      ...request,
      phase: "post",
      value: { credentials: { password: "secret", token: "keep" } },
    };
    const before = snapshot.evaluate(requestWithCredentials);

    verdict.type = "deny";
    verdict.paths[0] = "credentials.token";

    expect(snapshot.evaluate(requestWithCredentials)).toEqual(before);
    expect(snapshot.evaluate(requestWithCredentials)).toMatchObject({
      verdict: "transform",
      value: { credentials: { password: "[redacted]", token: "keep" } },
    });
  });

  it("reads exactly one kind/phase/op bucket and never reads storage on the hot path", () => {
    const unrelated = Array.from({ length: 220 }, (_, index) =>
      atGeneration(
        draft(`unrelated-${index}`, index % 2 === 0 ? "llm" : "prompt", "pre", {
          type: "allow",
        }),
        1,
      ),
    );
    const source = new MemoryPolicyRows([...initialRows(), ...unrelated]);
    const compiler = createPolicyCompiler({ source, mandatory: ["compaction"] });
    const evaluator = compiler.pin(1);
    const readsBefore = source.reads;

    for (let index = 0; index < 1_000; index += 1) evaluator.evaluate(request);
    const decision = evaluator.evaluate(request);

    expect(source.reads).toBe(readsBefore);
    expect(decision.matchedRuleIds).toEqual(["allow-read"]);
    expect(decision.bucket).toBe("tool/pre/read");
    expect(decision.evaluatedRuleCount).toBe(1);
  });
});
