import { describe, expect, it } from "bun:test";
import { compilePolicySnapshot, type CompiledPolicySnapshot } from "@openomni/policy";
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import { createDispatcher, createExecutor, defineTool } from "../src/index";
import { allowAllPolicy as allowAll, opPhaseOf, recordingLedger } from "./helpers/compiled-policy";
import { z } from "zod";

const denyPre = compilePolicySnapshot({
  generation: 1,
  mandatory: [],
  rows: [
    {
      name: "compaction",
      kind: "tool",
      phase: "pre",
      match: { encodingVersion: 1, value: { op: "echo" } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "not_allowed" } },
      priority: 1,
      generation: 1,
    },
  ],
});

function echoTool(onRun: () => void) {
  return defineTool({
    name: "echo",
    description: "Echo input",
    category: "query",
    input: z.object({ value: z.string() }).strict(),
    output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async ({ value }) => {
      onRun();
      return value;
    },
    render: (_input, value) => value,
  });
}

function durableExecutor(policy: CompiledPolicySnapshot, committed?: LedgerAction.Append[]) {
  const recording = recordingLedger(committed);
  return createExecutor({
    policy,
    ledger: recording.ledger,
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
    clock: () => 1,
    entropy: recording.entropy,
  });
}

function deniedDispatcher(executions: { count: number }) {
  return createDispatcher(
    [
      echoTool(() => {
        executions.count += 1;
      }),
    ],
    { executor: durableExecutor(denyPre) },
  );
}

const call = { id: "call-1", tool: "echo", input: { value: "secret" } };
const context = { sessionId: "session-1", turnId: "turn-1" };

describe("compiled tool.pre denial", () => {
  it("returns an error result through the model door without running the body", async () => {
    const executions = { count: 0 };

    const result = await deniedDispatcher(executions).execute(call, context);

    expect(executions.count).toBe(0);
    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
  });

  it("throws through the cell door without running the body", async () => {
    const executions = { count: 0 };

    const running: Promise<PlainValue> = deniedDispatcher(executions)
      .executeCell(call, context)
      .then((result) => result.output);

    await expect(running).rejects.toMatchObject({
      name: "ToolRefused",
      errorKind: "precondition_failed",
    });
    expect(executions.count).toBe(0);
  });
});

describe("cell-door executor propagation", () => {
  it("inherits the enclosing executor so nested cell tools commit durably", async () => {
    const committed: LedgerAction.Append[] = [];
    const executor = durableExecutor(allowAll, committed);

    // The inner dispatcher is built with NO executor option, exactly as the
    // production cell door does in apps/openomni/src/tools/execution/run-code.ts.
    const inner = createDispatcher([echoTool(() => undefined)]);
    const outer = createDispatcher(
      [
        defineTool({
          name: "outer",
          description: "Runs a nested cell tool",
          category: "query",
          input: z.object({}).strict(),
          output: z.string(),
          visibility: { model: ["resident"], cell: ["resident"] },
          execute: async () => {
            const nested = await inner.executeCell(
              { id: "call-inner", tool: "echo", input: { value: "nested" } },
              context,
            );
            return String(nested.output);
          },
          render: (_input, value) => value,
        }),
      ],
      { executor },
    );

    const result = await outer.execute({ id: "call-outer", tool: "outer", input: {} }, context);

    // A successful model-door result carries no isError key at all.
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("nested");
    // Both the outer and the nested tool committed intent+result through the
    // SAME durable executor: 2 tools x (intent + result) + policy decisions.
    const toolPhases = committed
      .filter((action) => action.kind === "tool")
      .map(opPhaseOf)
      .sort();
    expect(toolPhases).toEqual(["echo:intent", "echo:result", "outer:intent", "outer:result"]);
  });

  it("refuses a cell tool that has no enclosing executor at all", async () => {
    const orphan = createDispatcher([echoTool(() => undefined)]);

    await expect(
      orphan.executeCell({ id: "call-orphan", tool: "echo", input: { value: "x" } }, context),
    ).rejects.toMatchObject({ name: "ExecutorContextError", code: "executor_context_missing" });
  });
});
