import { expect, it } from "bun:test";
import { createDispatcher, defineTool, type Executor } from "../../../src/index";
import { Tool } from "@openomni/protocol";
import { z } from "zod";

it("the dispatcher owns exactly one Started/Completed pair around executor execution", async () => {
  const names: string[] = [];
  const executor: Executor = {
    async run(_request, body) {
      return { terminal: "executed", value: await body() };
    },
  };
  const dispatcher = createDispatcher(
    [
      defineTool({
        name: "echo",
        description: "Echo text",
        category: "query",
        input: z.object({ text: z.string() }).strict(),
        output: z.string(),
        visibility: { model: ["resident"], cell: ["resident"] },
        execute: async ({ text }) => text,
        render: (_input, output) => output,
      }),
    ],
    {
      executor,
      observations: { publish: (event) => names.push(event.name) },
      clock: () => 10,
    },
  );

  await dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "ok" } },
    { sessionId: "session-1", turnId: "turn-1" },
  );

  expect(names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});
