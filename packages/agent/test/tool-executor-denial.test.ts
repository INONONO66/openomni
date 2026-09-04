import { describe, expect, it } from "bun:test";
import { compilePolicySnapshot } from "@openomni/policy";
import { LedgerAction, type PlainValue } from "@openomni/protocol";
import { createDispatcher, createExecutor, defineTool, ToolRefused } from "../src/index";
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

/**
 * The compiler fails closed on a generation missing its mandatory rules, so an
 * "allow everything" snapshot still has to carry the mandatory compaction row.
 */
const allowAll = compilePolicySnapshot({
  generation: 1,
  mandatory: [],
  rows: [
    {
      name: "compaction",
      kind: "turn",
      phase: "post",
      match: { encodingVersion: 1, value: { op: "compaction" } },
      verdict: { encodingVersion: 1, value: { type: "allow" } },
      priority: 1000,
      generation: 1,
    },
  ],
});

/**
 * The executor carries `op` and `phase` inside the intent/effect payload
 * (executor.ts writes `{ phase, op, value }`), not as top-level node fields.
 */
function opPhaseOf(action: LedgerAction.Append): string {
  for (const carrier of [action.intent?.value, action.effect?.value]) {
    if (carrier === null || typeof carrier !== "object" || Array.isArray(carrier)) continue;
    const { op, phase } = carrier;
    if (typeof op === "string" && typeof phase === "string") return `${op}:${phase}`;
  }
  return "unknown";
}

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

function deniedDispatcher(executions: { count: number }) {
  let ordinal = 0;
  const executor = createExecutor({
    policy: denyPre,
    ledger: {
      async commit(action) {
        ordinal += 1;
        return { action: LedgerAction.Node.parse({ ...action, ordinal }), revision: ordinal };
      },
    },
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
    clock: () => 1,
    entropy: () => `action-${ordinal + 1}`,
  });
  return createDispatcher(
    [
      defineTool({
        name: "echo",
        description: "Echo input",
        category: "query",
        input: z.object({ value: z.string() }).strict(),
        output: z.string(),
        visibility: { model: ["resident"], cell: ["resident"] },
        execute: async ({ value }) => {
          executions.count += 1;
          return value;
        },
        render: (_input, value) => value,
      }),
    ],
    { executor },
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
    expect(result.output).toContain("not_allowed");
  });

  it("throws through the cell door without running the body", async () => {
    const executions = { count: 0 };

    const running: Promise<PlainValue> = deniedDispatcher(executions)
      .executeCell(call, context)
      .then((result) => result.output);

    await expect(running).rejects.toBeInstanceOf(ToolRefused);
    expect(executions.count).toBe(0);
  });
});

describe("cell-door executor propagation", () => {
  it("inherits the enclosing executor so nested cell tools commit durably", async () => {
    const committed: LedgerAction.Append[] = [];
    let ordinal = 0;
    const executor = createExecutor({
      policy: allowAll,
      ledger: {
        async commit(action) {
          committed.push(action);
          ordinal += 1;
          return { action: LedgerAction.Node.parse({ ...action, ordinal }), revision: ordinal };
        },
      },
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
      clock: () => 1,
      entropy: () => `action-${ordinal + 1}`,
    });

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

    const result = await outer.execute(
      { id: "call-outer", tool: "outer", input: {} },
      context,
    );

    // A successful model-door result carries no isError key at all.
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("nested");
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
    ).rejects.toThrow("tool dispatcher requires an executor");
  });
});
