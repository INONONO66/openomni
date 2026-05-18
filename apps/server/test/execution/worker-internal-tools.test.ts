import { describe, expect, it, mock } from "bun:test";

import type { Tool } from "@openomni/protocol";
import { WorkerInternalTools } from "../../src/execution/worker-internal-tools";
import type { WorkerRunState } from "../../src/execution/worker-run-state";

function createCall(id: string, tool: string, input: Tool.Call["input"] = {}): Tool.Call {
  return { id, tool, input };
}

function getTool(
  tools: ReturnType<typeof WorkerInternalTools.create>,
  name: string,
): ReturnType<typeof WorkerInternalTools.create>[number] {
  const tool = tools.find((candidate) => candidate.spec.name === name);
  if (!tool) {
    throw new Error(`Expected worker internal tool ${name}`);
  }
  return tool;
}

describe("worker internal tools", () => {
  it("ask_main requires a question", async () => {
    const tools = WorkerInternalTools.create({
      runId: "run-1",
      sessionId: "session-1",
      server: { call: mock(async () => ({ accepted: true, output: "unused" })) },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns: new Map<string, WorkerRunState.ActiveRun>(),
    });

    const result = await getTool(tools, "ask_main").execute(createCall("call-1", "ask_main", {}));

    expect(result).toMatchObject({
      toolCallId: "call-1",
      output: "ask_main requires a question",
      isError: true,
    });
  });

  it("ask_main rejects non-string question payloads", async () => {
    const tools = WorkerInternalTools.create({
      runId: "run-1",
      sessionId: "session-1",
      server: { call: mock(async () => ({ accepted: true, output: "unused" })) },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns: new Map<string, WorkerRunState.ActiveRun>(),
    });

    const result = await getTool(tools, "ask_main").execute(
      createCall("call-invalid", "ask_main", { question: { text: "Continue?" } }),
    );

    expect(result).toMatchObject({
      toolCallId: "call-invalid",
      output: "ask_main requires a question",
      isError: true,
    });
  });

  it("ask_main forwards the worker run context to the parent process", async () => {
    const serverCall = mock(async () => ({ accepted: true, output: "approved" }));
    const tools = WorkerInternalTools.create({
      runId: "run-1",
      sessionId: "session-1",
      server: { call: serverCall },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns: new Map<string, WorkerRunState.ActiveRun>(),
    });

    const result = await getTool(tools, "ask_main").execute(
      createCall("call-2", "ask_main", { question: "Continue?" }),
    );

    expect(serverCall).toHaveBeenCalledWith("worker.ask_main", {
      authToken: "token",
      workerId: "worker-1",
      sessionId: "session-1",
      runId: "run-1",
      question: "Continue?",
    });
    expect(result).toMatchObject({
      toolCallId: "call-2",
      output: "approved",
    });
    expect(result.isError).toBeUndefined();
  });

  it("ask_main returns rejected parent responses as tool errors", async () => {
    const tools = WorkerInternalTools.create({
      runId: "run-1",
      sessionId: "session-1",
      server: { call: mock(async () => ({ accepted: false, error: "no" })) },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns: new Map<string, WorkerRunState.ActiveRun>(),
    });

    const result = await getTool(tools, "ask_main").execute(
      createCall("call-3", "ask_main", { question: "Go?" }),
    );

    expect(result).toMatchObject({
      toolCallId: "call-3",
      output: "no",
      isError: true,
    });
  });

  it("check_inbox drains queued messages for the active run", async () => {
    const activeRuns = new Map<string, WorkerRunState.ActiveRun>([
      [
        "run-1",
        {
          sessionId: "session-1",
          controller: new AbortController(),
          inbox: ["hello", "world"],
        },
      ],
    ]);
    const tools = WorkerInternalTools.create({
      runId: "run-1",
      sessionId: "session-1",
      server: { call: mock(async () => ({ accepted: true, output: "unused" })) },
      ipcAuthToken: "token",
      workerId: "worker-1",
      activeRuns,
    });

    const result = await getTool(tools, "check_inbox").execute(createCall("call-4", "check_inbox"));

    expect(result).toMatchObject({
      toolCallId: "call-4",
      output: JSON.stringify({ messages: ["hello", "world"], count: 2 }),
    });
    expect(activeRuns.get("run-1")?.inbox).toEqual([]);
  });
});
