import { expect, test } from "bun:test";
import { z } from "zod";
import { createTurnDispatcher, defineTool, sessionTool } from "../src/tool-dispatcher";
import { compiledPolicy, recordingLedger } from "./helpers/compiled-policy";

function definition(input = z.object({ value: z.string() })) {
  return defineTool({
    name: "captured",
    category: "query",
    description: "captured",
    input,
    output: z.string(),
    visibility: { model: ["resident"], cell: [] },
    execute: async () => "done",
    render: (_input, value) => value,
  });
}

test("recovery refuses a missing or changed captured definition instead of executing latest code", () => {
  const original = definition();
  const record = recordingLedger();
  const input = {
    sessionId: "session",
    role: "resident" as const,
    actionId: "resume-action",
    turnId: "original-turn",
    toolsGeneration: 1,
    toolsHash: "captured-hash",
    policy: compiledPolicy(),
    ledger: record.ledger,
    tools: [sessionTool(original)],
  };
  for (const definitions of [[], [definition(z.object({ value: z.string().min(2) }))]]) {
    expect(() =>
      createTurnDispatcher(definitions, input, { observations: { publish: () => undefined } }),
    ).toThrow("captured catalog mismatch");
  }
  expect(record.committed).toEqual([]);
});

test("a recovered tool and its policy decisions remain children of the captured turn, not the resume checkpoint", async () => {
  const tool = definition();
  const record = recordingLedger();
  const dispatcher = createTurnDispatcher(
    [tool],
    {
      sessionId: "session",
      role: "resident",
      actionId: "resume-action",
      turnId: "original-turn",
      tools: [sessionTool(tool)],
      policy: compiledPolicy(),
      ledger: record.ledger,
    },
    { observations: { publish: () => undefined }, entropy: record.entropy },
  );
  expect(
    (
      await dispatcher.execute(
        { id: "call", tool: "captured", input: { value: "ok" } },
        { sessionId: "session", turnId: "original-turn" },
      )
    ).isError,
  ).toBeUndefined();
  expect(
    record.committed
      .filter((action) => action.kind === "policy.decision")
      .map((action) => action.parentId),
  ).toEqual(["original-turn", "original-turn"]);
  expect(record.committed.find((action) => action.kind === "tool")?.parentId).toBe("original-turn");
});
