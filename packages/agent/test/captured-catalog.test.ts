import { expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { recordingLedger } from "./helpers/effect-g3-recording";
import { createTurnDispatcher } from "../src/tool-dispatcher";
import { defineTool, sessionTool } from "../src/tool-dispatcher";
import { compiledPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";

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

test("a recovered tool and its policy decisions remain children of the captured turn, not the resume checkpoint", () =>
  isolated(
    Effect.gen(function* () {
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
      const result = yield* dispatcher.execute(
        { id: "call", tool: "captured", input: { value: "ok" } },
        { sessionId: "session", turnId: "original-turn" },
      );
      expect(result.isError).toBeUndefined();
      expect(
        record.committed
          .filter((action) => action.kind === "policy.decision")
          .map((action) => action.parentId),
      ).toEqual(["original-turn", "original-turn"]);
      expect(record.committed.find((action) => action.kind === "tool")?.parentId).toBe("original-turn");
    }),
  ));

