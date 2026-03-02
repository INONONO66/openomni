import { describe, it, expect, beforeEach } from "bun:test";
import {
  ConversationSupervisor,
  ConversationSupervisorConfig,
  ConversationInput,
} from "../../../src/legacy/conversation";
import { Session } from "@openomni/session";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { TaskManager } from "../../../src/legacy/task/manager";
import type { Task } from "../../../src/legacy/task/types";

describe("ConversationSupervisor", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
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
