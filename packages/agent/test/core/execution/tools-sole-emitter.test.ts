import { expect, it } from "bun:test";
import {
  createDispatcher,
  defineTool,
  type ToolExecutionCommitter,
  type ToolExecutionObservation,
} from "../../../src/index";
import { Tool } from "@openomni/protocol";
import { z } from "zod";

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(() => timeout.reject(new Error(`timed out waiting for ${label}`)), 1_000);
  return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}

it("the dispatcher emits Started/Completed once and only after matching commits", async () => {
  const intentGate = Promise.withResolvers<void>();
  const resultGate = Promise.withResolvers<void>();
  const intentEntered = Promise.withResolvers<void>();
  const resultEntered = Promise.withResolvers<void>();
  const events: string[] = [];
  const committer: ToolExecutionCommitter = {
    async intent() {
      intentEntered.resolve();
      await intentGate.promise;
    },
    async result() {
      resultEntered.resolve();
      await resultGate.promise;
    },
  };
  const observations: ToolExecutionObservation = {
    publish(event) {
      events.push(event.name);
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
        render: (_args, value) => value,
      }),
    ],
    { commits: committer, observations, clock: () => 10 },
  );

  const running = dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "ok" } },
    {
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      signal: new AbortController().signal,
    },
  );
  await bounded(intentEntered.promise, "intent commit entry");
  expect(events).toEqual([]);

  intentGate.resolve();
  await bounded(resultEntered.promise, "result commit entry");
  expect(events).toEqual([Tool.Events.Started.name]);

  resultGate.resolve();
  await running;
  expect(events).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});

it("emits TimedOut once after the timeout result commit", async () => {
  const names: string[] = [];
  const dispatcher = createDispatcher(
    [
      defineTool({
        name: "slow",
        description: "Wait cooperatively",
        category: "execution",
        input: z.object({}).strict(),
        output: z.string(),
        visibility: { model: ["resident"], cell: [] },
        execute: (_args, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve("late"), { once: true });
          }),
        render: (_args, value) => value,
      }),
    ],
    {
      timeoutMs: 1,
      commits: { intent: async () => undefined, result: async () => undefined },
      observations: { publish: (event) => names.push(event.name) },
    },
  );

  const result = await dispatcher.execute(
    { id: "call-timeout", tool: "slow", input: {} },
    {
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-timeout",
      signal: new AbortController().signal,
    },
  );

  expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  expect(names).toEqual([Tool.Events.Started.name, Tool.Events.TimedOut.name]);
});
