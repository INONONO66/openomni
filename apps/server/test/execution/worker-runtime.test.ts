import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { SystemToolProvider } from "@openomni/openomni";
import { Session, Storage, initialize } from "@openomni/session";
import {
  buildWorkerInputMessages,
  createExecutionToolContext,
  resolveWorkerDbPath,
  selectRequestedTools,
} from "../../src/execution/worker-runtime";

const model = { providerID: "test", modelID: "fixture" };

function addTextMessage(sessionId: string, role: "user" | "assistant", text: string): void {
  const messageId = crypto.randomUUID();
  const message =
    role === "user"
      ? ({
          id: messageId,
          sessionID: sessionId,
          role,
          time: { created: Date.now() },
          agent: "test",
          model,
        } satisfies Message.UserMessage)
      : ({
          id: messageId,
          sessionID: sessionId,
          role,
          time: { created: Date.now() },
          parentID: "",
          modelID: model.modelID,
          providerID: model.providerID,
          agent: "test",
          path: { cwd: process.cwd(), root: process.cwd() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies Message.AssistantMessage);

  Session.addMessage(sessionId, message);
  Session.addPart(messageId, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  });
}

describe("worker-runtime", () => {
  it("resolves the worker db path from server config", () => {
    const original = process.env.OPENOMNI_DB_PATH;
    delete process.env.OPENOMNI_DB_PATH;

    try {
      expect(
        resolveWorkerDbPath({
          storage: {
            dbPath: "/tmp/openomni-custom.db",
          },
        }),
      ).toBe("/tmp/openomni-custom.db");
    } finally {
      if (original === undefined) {
        delete process.env.OPENOMNI_DB_PATH;
      } else {
        process.env.OPENOMNI_DB_PATH = original;
      }
    }
  });

  it("selects requested tools by sanitized protocol names", () => {
    const availableTools = new SystemToolProvider("/workspace/openomni").listTools();

    const selected = selectRequestedTools(availableTools, [
      { name: "bash", inputSchema: { type: "object" } },
      { name: "grep_search", inputSchema: { type: "object" } },
    ]);

    expect(selected.map((tool) => tool.spec.name)).toEqual(["bash", "grep.search"]);
  });

  it("rebuilds a tool executor and leaves request permissions to agent policy", async () => {
    const availableTools = new SystemToolProvider("/workspace/openomni").listTools();
    const context = createExecutionToolContext(
      {
        tools: [{ name: "bash", inputSchema: { type: "object" } }],
        permissions: { action: "tool.call", denylist: ["bash"] },
        toolConfig: { workspaceRoot: "/workspace/openomni" },
      },
      availableTools,
    );

    expect(context.tools).toHaveLength(1);
    expect(context.tools?.[0]?.name).toBe("bash");
    expect(context.toolExecutor).toBeDefined();

    if (!context.toolExecutor) throw new Error("expected toolExecutor to be defined");
    const result = await context.toolExecutor({
      id: crypto.randomUUID(),
      tool: "bash",
      input: { command: "pwd" },
    });

    expect(result.output).not.toContain("denied by policy");
  });

  it("only advertises tools that the worker executor can run", () => {
    const availableTools = new SystemToolProvider("/workspace/openomni").listTools();
    const context = createExecutionToolContext(
      {
        tools: [
          { name: "bash", inputSchema: { type: "object" } },
          { name: "spawn_worker", inputSchema: { type: "object" } },
        ],
        toolConfig: { workspaceRoot: "/workspace/openomni" },
      },
      availableTools,
    );

    expect(context.tools?.map((tool) => tool.name)).toEqual(["bash"]);
    expect(context.toolExecutor).toBeDefined();
  });
});

describe("worker runtime input messages", () => {
  beforeEach(() => {
    Storage.reset();
    initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("uses the projected session prompt when it is already the latest user message", () => {
    const session = Session.create({ title: "worker", model });
    addTextMessage(session.id, "user", "do the work");

    expect(buildWorkerInputMessages(session.id, "do the work")).toEqual([
      { role: "user", content: "do the work" },
    ]);
  });

  test("falls back to the execution request prompt when projection is empty", () => {
    expect(buildWorkerInputMessages("missing-session", "do the work")).toEqual([
      { role: "user", content: "do the work" },
    ]);
  });

  test("appends the request prompt after stale projected history", () => {
    const session = Session.create({ title: "worker", model });
    addTextMessage(session.id, "user", "old request");
    addTextMessage(session.id, "assistant", "old answer");

    expect(buildWorkerInputMessages(session.id, "new request")).toEqual([
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new request" },
    ]);
  });
});
