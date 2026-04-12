import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult } from "@openomni/agent";
import { Session, Storage, WorkerRun } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";
import { get as getAbortEntry } from "../../src/subagent/abort-registry";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };
const sessionModel = { providerID: "anthropic", modelID: "claude-3-haiku-20240307" };

let createSpy: ReturnType<typeof spyOn>;

function mockSuccess(text: string): void {
  createSpy.mockImplementation(
    () =>
      ({
        run: async () =>
          ({
            text,
            steps: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: "stop",
          }) satisfies AgentResult,
      }) as unknown as ReturnType<typeof ChatAgent.create>,
  );
}

function mockFailure(message: string): void {
  createSpy.mockImplementation(
    () =>
      ({
        run: async () => {
          throw new Error(message);
        },
      }) as unknown as ReturnType<typeof ChatAgent.create>,
  );
}

function createParentSession(): string {
  return Session.create({ title: "parent", model: sessionModel }).id;
}

beforeEach(() => {
  Storage.reset();
  createSpy = spyOn(ChatAgent, "create").mockImplementation(
    () =>
      ({
        run: async () => {
          throw new Error("no mock configured");
        },
      }) as unknown as ReturnType<typeof ChatAgent.create>,
  );
});

afterEach(() => {
  createSpy.mockRestore();
});

describe("finally cleanup — spawn", () => {
  it("marks WorkerRun as failed when agent throws", async () => {
    mockFailure("agent exploded");
    const parentId = createParentSession();

    await expect(
      SubagentRuntime.spawn({
        parentSessionId: parentId,
        agentName: "worker",
        title: "task",
        prompt: "do work",
        model,
      }),
    ).rejects.toThrow("agent exploded");

    const children = Session.listChildren(parentId);
    expect(children).toHaveLength(1);
    const childId = children[0]?.id ?? "";
    const runs = await WorkerRun.listBySession(childId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
  });

  it("preserves user message after failure (never deletes)", async () => {
    mockFailure("crash");
    const parentId = createParentSession();

    await expect(
      SubagentRuntime.spawn({
        parentSessionId: parentId,
        agentName: "worker",
        title: "task",
        prompt: "my prompt",
        model,
      }),
    ).rejects.toThrow("crash");

    const children = Session.listChildren(parentId);
    const messages = Session.getMessages(children[0]?.id ?? "");
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);

    const parts = Session.getParts(userMessages[0]?.id ?? "");
    const textPart = parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect((textPart as { text: string }).text).toBe("my prompt");
  });

  it("removes AbortController from registry after failure", async () => {
    mockFailure("boom");
    const parentId = createParentSession();

    await expect(
      SubagentRuntime.spawn({
        parentSessionId: parentId,
        agentName: "worker",
        title: "task",
        prompt: "do work",
        model,
      }),
    ).rejects.toThrow("boom");

    const children = Session.listChildren(parentId);
    expect(getAbortEntry(children[0]?.id ?? "")).toBeUndefined();
  });

  it("updates workerMeta status to failed after agent failure", async () => {
    mockFailure("fatal");
    const parentId = createParentSession();

    await expect(
      SubagentRuntime.spawn({
        parentSessionId: parentId,
        agentName: "worker",
        title: "task",
        prompt: "do work",
        model,
      }),
    ).rejects.toThrow("fatal");

    const children = Session.listChildren(parentId);
    const meta = Session.getWorkerMeta(children[0]?.id ?? "");
    expect(meta).toBeDefined();
    expect((meta as Record<string, unknown>).status).toBe("failed");
  });

  it("updates workerMeta status to idle after success", async () => {
    mockSuccess("done");
    const parentId = createParentSession();

    const result = await SubagentRuntime.spawn({
      parentSessionId: parentId,
      agentName: "worker",
      title: "task",
      prompt: "do work",
      model,
    });

    const meta = Session.getWorkerMeta(result.sessionId);
    expect(meta).toBeDefined();
    expect((meta as Record<string, unknown>).status).toBe("idle");
  });
});

describe("finally cleanup — send", () => {
  it("marks WorkerRun failed and updates workerMeta on failure", async () => {
    mockSuccess("first");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "init",
      model,
    });

    mockFailure("send failed");
    await expect(
      SubagentRuntime.send({ sessionId: spawned.sessionId, prompt: "retry", model }),
    ).rejects.toThrow("send failed");

    const runs = await WorkerRun.listBySession(spawned.sessionId);
    const lastRun = runs[runs.length - 1];
    expect(lastRun?.status).toBe("failed");

    expect(getAbortEntry(spawned.sessionId)).toBeUndefined();

    const meta = Session.getWorkerMeta(spawned.sessionId);
    expect(meta).toBeDefined();
    expect((meta as Record<string, unknown>).status).toBe("failed");
  });

  it("preserves user message after send failure", async () => {
    mockSuccess("first");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "init",
      model,
    });

    mockFailure("oops");
    await expect(
      SubagentRuntime.send({ sessionId: spawned.sessionId, prompt: "second prompt", model }),
    ).rejects.toThrow("oops");

    const messages = Session.getMessages(spawned.sessionId);
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
  });
});

describe("finally cleanup — resume", () => {
  it("marks WorkerRun failed and updates workerMeta on failure", async () => {
    mockSuccess("first");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "do work",
      model,
    });

    mockFailure("resume exploded");
    await expect(SubagentRuntime.resume({ sessionId: spawned.sessionId, model })).rejects.toThrow(
      "resume exploded",
    );

    const runs = await WorkerRun.listBySession(spawned.sessionId);
    const lastRun = runs[runs.length - 1];
    expect(lastRun?.status).toBe("failed");

    expect(getAbortEntry(spawned.sessionId)).toBeUndefined();

    const meta = Session.getWorkerMeta(spawned.sessionId);
    expect(meta).toBeDefined();
    expect((meta as Record<string, unknown>).status).toBe("failed");
  });
});
