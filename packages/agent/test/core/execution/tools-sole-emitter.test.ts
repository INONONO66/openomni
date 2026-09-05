import { expect, it, jest } from "bun:test";
import { Tool } from "@openomni/protocol";
import { createDispatcher, defineTool } from "../../../src/index";
import { z } from "zod";
import {
  actionCommitGate,
  compiledPolicy,
  recordingExecutor,
  recordingToolObservations,
} from "../../helpers/compiled-policy";

function echoTool(execute: (text: string) => Promise<string>) {
  return defineTool({
    name: "echo",
    description: "Echo text",
    category: "query",
    input: z.object({ text: z.string() }).strict(),
    output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async ({ text }) => execute(text),
    render: (_input, output) => output,
  });
}

it("publishes no lifecycle event when pre policy blocks before tool intent", async () => {
  const observations = recordingToolObservations();
  const recording = recordingExecutor({
    policy: compiledPolicy([
      {
        name: "deny-echo",
        kind: "tool",
        phase: "pre",
        match: { encodingVersion: 1, value: { op: "echo" } },
        verdict: { encodingVersion: 1, value: { type: "deny", reason: "blocked" } },
        priority: 1,
        generation: 1,
      },
    ]),
    onObservation: observations.observe,
    clock: () => 10,
  });
  let bodyCalls = 0;
  const dispatcher = createDispatcher([
    echoTool(async (text) => {
      bodyCalls += 1;
      return text;
    }),
  ], { executor: recording.executor });

  const result = await dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "blocked" } },
    { sessionId: "session-1", turnId: "turn-1" },
  );

  expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
  expect(bodyCalls).toBe(0);
  expect(recording.committed.filter((action) => action.kind === "tool")).toEqual([]);
  expect(observations.names).toEqual([]);
});

it("publishes Started after intent commit and Completed after result commit", async () => {
  const intentCommit = actionCommitGate("echo:intent");
  const resultCommit = actionCommitGate("echo:result");
  const startedSeen = Promise.withResolvers<void>();
  const completedSeen = Promise.withResolvers<void>();
  const observations = recordingToolObservations((name) => {
    if (name === Tool.Events.Started.name) startedSeen.resolve();
    if (name === Tool.Events.Completed.name) completedSeen.resolve();
  });
  const recording = recordingExecutor({
    onCommit: async (action) => {
      await intentCommit.onCommit(action);
      await resultCommit.onCommit(action);
    },
    onObservation: observations.observe,
    clock: () => 10,
  });
  const dispatcher = createDispatcher([echoTool(async (text) => text)], { executor: recording.executor });

  const running = dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "ok" } },
    { sessionId: "session-1", turnId: "turn-1" },
  );
  await intentCommit.reached;
  expect(observations.names).toEqual([]);

  intentCommit.release();
  await startedSeen.promise;
  expect(observations.names).toEqual([Tool.Events.Started.name]);

  await resultCommit.reached;
  expect(observations.names).toEqual([Tool.Events.Started.name]);
  resultCommit.release();
  await Promise.all([running, completedSeen.promise]);
  expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});

it("publishes one error completion after a failed tool result commits", async () => {
  const observations = recordingToolObservations();
  const recording = recordingExecutor({
    onObservation: observations.observe,
    clock: () => 10,
  });
  const dispatcher = createDispatcher(
    [echoTool(() => Promise.reject(new TypeError("failed")))],
    { executor: recording.executor },
  );

  const result = await dispatcher.execute(
    { id: "call-1", tool: "echo", input: { text: "fail" } },
    { sessionId: "session-1", turnId: "turn-1" },
  );

  expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  expect(recording.committed.filter((action) => action.kind === "tool")).toHaveLength(2);
  expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
});

it("publishes TimedOut and Completed exactly once after the timeout result commits", async () => {
  jest.useFakeTimers();
  try {
    const resultCommit = actionCommitGate("echo:result");
    const startedSeen = Promise.withResolvers<void>();
    const observations = recordingToolObservations((name) => {
      if (name === Tool.Events.Started.name) startedSeen.resolve();
    });
    const recording = recordingExecutor({
      onCommit: resultCommit.onCommit,
      onObservation: observations.observe,
      clock: Date.now,
    });
    const dispatcher = createDispatcher(
      [echoTool(() => new Promise<string>(() => undefined))],
      { executor: recording.executor, timeoutMs: 50 },
    );

    const running = dispatcher.execute(
      { id: "call-1", tool: "echo", input: { text: "stall" } },
      { sessionId: "session-1", turnId: "turn-1" },
    );
    await startedSeen.promise;
    jest.advanceTimersByTime(50);
    await resultCommit.reached;
    expect(observations.names).toEqual([Tool.Events.Started.name]);
    resultCommit.release();
    const result = await running;

    expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
    expect(recording.committed.filter((action) => action.kind === "tool")).toHaveLength(2);
    expect(observations.names).toEqual([
      Tool.Events.Started.name,
      Tool.Events.TimedOut.name,
      Tool.Events.Completed.name,
    ]);
  } finally {
    jest.useRealTimers();
  }
});
