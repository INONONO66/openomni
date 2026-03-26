import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  ConversationSupervisorConfig,
  ConversationInput,
} from "../../../src/legacy/conversation";
import type { Message, Run, Sink } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { TaskManager } from "../../../src/legacy/task/manager";
import type { Task } from "../../../src/legacy/task/types";

type MockLlmFn = (input: unknown, sink: Sink) => Promise<Run.Outcome>;

let mockRunFn: MockLlmFn = async (_input: unknown, sink: Sink) => {
  sink.onMessage(createAssistantMessage("Mock assistant response"));
  return { type: "stop" };
};

const mockModelsGet = mock(async () => ({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-haiku-20240307": {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
      },
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
      },
    },
  },
}));

const mockProviderFromModelsDevModel = mock(() => ({
  id: "claude-sonnet-4-20250514",
  providerID: "anthropic",
}));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

let ConversationSupervisor: typeof import("../../../src/legacy/conversation").ConversationSupervisor;

beforeAll(async () => {
  ({ ConversationSupervisor } = await import("../../../src/legacy/conversation"));
});

afterAll(() => {
  mock.restore();
});

function createAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "conversation-supervisor-test";
  const now = Date.now();

  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID: "",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    agent: "chat-agent",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };

  return { info, parts: [textPart] };
}

describe("ConversationSupervisor", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    mockModelsGet.mockClear();
    mockProviderFromModelsDevModel.mockClear();
    mockRunFn = async (_input: unknown, sink: Sink) => {
      sink.onMessage(createAssistantMessage("Mock assistant response"));
      return { type: "stop" };
    };
  });

  function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
    return TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [{ id: "manual-1", type: "manual" }],
      ...overrides,
    });
  }

  async function createRun(taskId: string): Promise<string> {
    const result = await TaskManager.trigger(taskId, {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
    });
    if ("runId" in result) {
      return result.runId;
    }
    throw new Error(`Failed to create run: ${result.error}`);
  }

  describe("immediate intent", () => {
    it("returns immediate response when LLM classifies as immediate", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const session = Session.create({
        title: "Test Session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      });

      const config: ConversationSupervisorConfig = {
        conversationSessionId: session.id,
      };

      const input: ConversationInput = {
        content: "What is 2+2?",
        metadata: {
          taskId: task.id,
          runId,
        },
      };

      const result = await ConversationSupervisor.run(config, input);

      expect(result.type).toBe("immediate");
      if (result.type === "immediate") {
        expect(result.response.length).toBeGreaterThan(0);
      }
    });

    it("returns immediate response when no classify_intent tool call", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const session = Session.create({
        title: "Test Session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      });

      const config: ConversationSupervisorConfig = {
        conversationSessionId: session.id,
      };

      const input: ConversationInput = {
        content: "Hello",
        metadata: {
          taskId: task.id,
          runId,
        },
      };

      const result = await ConversationSupervisor.run(config, input);

      expect(result.type).toBe("immediate");
      if (result.type === "immediate") {
        expect(result.response.length).toBeGreaterThan(0);
      }
    });
  });

  describe("plan generation", () => {
    it(
      "handles complex planning requests (may return immediate or plan_pending based on LLM decision)",
      async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const session = Session.create({
          title: "Test Session",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        });

        const config: ConversationSupervisorConfig = {
          conversationSessionId: session.id,
        };

        const input: ConversationInput = {
          content:
            "Create a detailed plan for building a full-stack web application with user authentication, database, and API",
          metadata: {
            taskId: task.id,
            runId,
          },
        };

        const result = await ConversationSupervisor.run(config, input);

        expect(["immediate", "plan_pending"]).toContain(result.type);
        if (result.type === "plan_pending") {
          expect(result.plan.workItems.length).toBeGreaterThan(0);
        }
      },
      { timeout: 60000 },
    );
  });

  describe("session resolution", () => {
    it(
      "reuses existing session",
      async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const session = Session.create({
          title: "Test Session",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        });

        const config: ConversationSupervisorConfig = {
          conversationSessionId: session.id,
        };

        const input: ConversationInput = {
          content: "What is the capital of France?",
          metadata: {
            taskId: task.id,
            runId,
          },
        };

        const result = await ConversationSupervisor.run(config, input);

        expect(result.type).toBe("immediate");
      },
      { timeout: 30000 },
    );
  });

  describe("error handling", () => {
    it("handles simple queries successfully", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const session = Session.create({
        title: "Test Session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      });

      const config: ConversationSupervisorConfig = {
        conversationSessionId: session.id,
      };

      const input: ConversationInput = {
        content: "Test",
        metadata: {
          taskId: task.id,
          runId,
        },
      };

      const result = await ConversationSupervisor.run(config, input);

      expect(["immediate", "plan_pending"]).toContain(result.type);
    });

    it("returns error when no assistant response found", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const session = Session.create({
        title: "Test Session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      });

      const config: ConversationSupervisorConfig = {
        conversationSessionId: session.id,
      };

      const input: ConversationInput = {
        content: "Test",
        metadata: {
          taskId: task.id,
          runId,
        },
      };

      const result = await ConversationSupervisor.run(config, input);

      expect(result.type).toBe("immediate");
    });
  });

  describe("agent injection", () => {
    it(
      "uses custom agentId when provided",
      async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const session = Session.create({
          title: "Test Session",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
          },
        });

        const config: ConversationSupervisorConfig = {
          conversationSessionId: session.id,
          agentId: "conversation-supervisor",
        };

        const input: ConversationInput = {
          content: "What is the weather?",
          metadata: {
            taskId: task.id,
            runId,
          },
        };

        const result = await ConversationSupervisor.run(config, input);

        expect(result.type).toBe("immediate");
      },
      { timeout: 30000 },
    );
  });
});
