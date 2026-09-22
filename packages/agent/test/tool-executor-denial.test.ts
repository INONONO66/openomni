import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "bun:test";
import { stringQueryTool, valueTool } from "./helpers/query-tool";
import { compilePolicySnapshot, type CompiledPolicySnapshot } from "@openomni/policy";
import type { LedgerAction } from "@openomni/protocol";
import { createDispatcher } from "../src/index";
import { allowAllPolicy as allowAll, opPhaseOf } from "./helpers/compiled-policy";
import { turnExecutor } from "./helpers/effect-g1";
import { isolated } from "./helpers/isolated";

const denyPre = compilePolicySnapshot({ generation: 1, mandatory: [], rows: [{
  name: "compaction", kind: "tool", phase: "pre", match: { encodingVersion: 1, value: { op: "echo" } },
  verdict: { encodingVersion: 1, value: { type: "deny", reason: "not_allowed" } }, priority: 1, generation: 1,
}] });
function echoTool(onRun: () => void) {
  return valueTool({ name: "echo", description: "Echo input", execute: async (value) => { onRun(); return value; } });
}
function durableExecutor(policy: CompiledPolicySnapshot, committed?: LedgerAction.Append[]) { return turnExecutor(policy, committed).executor; }
function deniedDispatcher(executions: { count: number }) { return createDispatcher([echoTool(() => { executions.count += 1; })], { executor: durableExecutor(denyPre) }); }
const call = { id: "call-1", tool: "echo", input: { value: "secret" } };
const context = { sessionId: "session-1", turnId: "turn-1" };

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  return Cause.squash(exit.cause);
}

describe("compiled tool.pre denial", () => {
  it("normalizes noncanonical numeric tool results without rejecting", async () => isolated(Effect.gen(function* () {
    const result = yield* durableExecutor(allowAll).run({ kind: "tool", op: "number", intent: {}, effect: {} }, () => Effect.succeed(Number.POSITIVE_INFINITY));
    expect(result).toMatchObject({ terminal: "executed", value: null });
  })));
  it("returns an error result through the model door without running the body", async () => isolated(Effect.gen(function* () {
    const executions = { count: 0 };
    const result = yield* deniedDispatcher(executions).execute(call, context);
    expect(executions.count).toBe(0);
    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
  })));
  it("throws through the cell door without running the body", async () => isolated(Effect.gen(function* () {
    const executions = { count: 0 };
    const exit = yield* Effect.exit(deniedDispatcher(executions).executeCell(call, context));
    const error = failureOf(exit);
    expect(error).toMatchObject({ name: "ToolRefused", errorKind: "precondition_failed" });
    expect(executions.count).toBe(0);
  })));
});

describe("cell-door executor propagation", () => {
  it("inherits the enclosing executor so nested cell tools commit durably", async () => isolated(Effect.gen(function* () {
    const committed: LedgerAction.Append[] = [];
    const executor = durableExecutor(allowAll, committed);
    const inner = createDispatcher([echoTool(() => undefined)]);
    const outer = createDispatcher([stringQueryTool("outer", "Runs a nested cell tool", async () => {
      const nested = await isolated(inner.executeCell({ id: "call-inner", tool: "echo", input: { value: "nested" } }, context));
      return String(nested.output);
    })], { executor });
    const result = yield* outer.execute({ id: "call-outer", tool: "outer", input: {} }, context);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("nested");
    expect(committed.filter((action) => action.kind === "tool").map(opPhaseOf).sort()).toEqual(["echo:intent", "echo:result", "outer:intent", "outer:result"]);
  })));
  it("refuses a cell tool that has no enclosing executor at all", async () => isolated(Effect.gen(function* () {
    const exit = yield* Effect.exit(createDispatcher([echoTool(() => undefined)]).executeCell({ id: "call-orphan", tool: "echo", input: { value: "x" } }, context));
    expect(failureOf(exit)).toMatchObject({ name: "ExecutorContextError", code: "executor_context_missing" });
  })));
});
