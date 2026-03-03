import { describe, it, expect } from "bun:test";
import { SubagentInput } from "../../../src/legacy/tools/subagent";
import { DispatchInput } from "../../../src/legacy/tools/dispatch";
import { ScheduleInput } from "../../../src/legacy/tools/schedule";

describe("Tool Schemas", () => {
  describe("SubagentInput", () => {
    it("parses valid input", () => {
      const input = {
        agentType: "explore",
        prompt: "Find all TypeScript files in src/",
      };
      const result = SubagentInput.parse(input);
      expect(result.agentType).toBe("explore");
      expect(result.prompt).toBe("Find all TypeScript files in src/");
      expect(result.sessionId).toBeUndefined();
    });

    it("parses valid input with sessionId", () => {
      const input = {
        agentType: "implement",
        prompt: "Add error handling",
        sessionId: "ses_abc123",
      };
      const result = SubagentInput.parse(input);
      expect(result.sessionId).toBe("ses_abc123");
    });

    it("rejects missing agentType", () => {
      const input = {
        prompt: "Find all TypeScript files in src/",
      };
      expect(() => SubagentInput.parse(input)).toThrow();
    });

    it("rejects missing prompt", () => {
      const input = {
        agentType: "explore",
      };
      expect(() => SubagentInput.parse(input)).toThrow();
    });

    it("rejects non-string agentType", () => {
      const input = {
        agentType: 123,
        prompt: "Find all TypeScript files in src/",
      };
      expect(() => SubagentInput.parse(input)).toThrow();
    });

    it("rejects non-string prompt", () => {
      const input = {
        agentType: "explore",
        prompt: 456,
      };
      expect(() => SubagentInput.parse(input)).toThrow();
    });
  });

  describe("DispatchInput", () => {
    it("parses valid input with minimal tasks", () => {
      const input = {
        objective: "Implement authentication",
        tasks: [
          {
            id: "task-1",
            description: "Create auth schema",
            agentType: "implement",
          },
        ],
      };
      const result = DispatchInput.parse(input);
      expect(result.objective).toBe("Implement authentication");
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe("task-1");
      expect(result.tasks[0].dependencies).toEqual([]);
      expect(result.tasks[0].fileScope).toEqual([]);
    });

    it("parses valid input with full task details", () => {
      const input = {
        objective: "Implement authentication",
        tasks: [
          {
            id: "task-1",
            description: "Create auth schema",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/auth/schema.ts"],
          },
          {
            id: "task-2",
            description: "Add auth routes",
            agentType: "implement",
            dependencies: ["task-1"],
            fileScope: ["src/routes/auth.ts"],
          },
        ],
      };
      const result = DispatchInput.parse(input);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[1].dependencies).toEqual(["task-1"]);
      expect(result.tasks[1].fileScope).toEqual(["src/routes/auth.ts"]);
    });

    it("rejects missing objective", () => {
      const input = {
        tasks: [
          {
            id: "task-1",
            description: "Create auth schema",
            agentType: "implement",
          },
        ],
      };
      expect(() => DispatchInput.parse(input)).toThrow();
    });

    it("rejects missing tasks array", () => {
      const input = {
        objective: "Implement authentication",
      };
      expect(() => DispatchInput.parse(input)).toThrow();
    });

    it("rejects task with missing id", () => {
      const input = {
        objective: "Implement authentication",
        tasks: [
          {
            description: "Create auth schema",
            agentType: "implement",
          },
        ],
      };
      expect(() => DispatchInput.parse(input)).toThrow();
    });

    it("rejects task with missing description", () => {
      const input = {
        objective: "Implement authentication",
        tasks: [
          {
            id: "task-1",
            agentType: "implement",
          },
        ],
      };
      expect(() => DispatchInput.parse(input)).toThrow();
    });

    it("rejects task with missing agentType", () => {
      const input = {
        objective: "Implement authentication",
        tasks: [
          {
            id: "task-1",
            description: "Create auth schema",
          },
        ],
      };
      expect(() => DispatchInput.parse(input)).toThrow();
    });

    it("rejects non-array dependencies", () => {
      const input = {
        objective: "Implement authentication",
        tasks: [
          {
            id: "task-1",
            description: "Create auth schema",
            agentType: "implement",
            dependencies: "task-0",
          },
        ],
      };
      expect(() => DispatchInput.parse(input)).toThrow();
    });
  });

  describe("ScheduleInput", () => {
    it("parses valid input with minimal fields", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 5000,
      };
      const result = ScheduleInput.parse(input);
      expect(result.description).toBe("Run daily backup");
      expect(result.dueAt).toBe("2025-12-31T23:59:59Z");
      expect(result.estimatedRuntimeMs).toBe(5000);
      expect(result.recurring).toBeUndefined();
    });

    it("parses valid input with cron recurrence", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 5000,
        recurring: {
          type: "cron",
          expression: "0 0 * * *",
        },
      };
      const result = ScheduleInput.parse(input);
      expect(result.recurring?.type).toBe("cron");
      expect(result.recurring?.expression).toBe("0 0 * * *");
    });

    it("parses valid input with interval recurrence", () => {
      const input = {
        description: "Run every hour",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 3000,
        recurring: {
          type: "interval",
          intervalMs: 3600000,
        },
      };
      const result = ScheduleInput.parse(input);
      expect(result.recurring?.type).toBe("interval");
      expect(result.recurring?.intervalMs).toBe(3600000);
    });

    it("parses valid input with once recurrence", () => {
      const input = {
        description: "Run once",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 2000,
        recurring: {
          type: "once",
        },
      };
      const result = ScheduleInput.parse(input);
      expect(result.recurring?.type).toBe("once");
    });

    it("rejects missing description", () => {
      const input = {
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 5000,
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });

    it("rejects missing dueAt", () => {
      const input = {
        description: "Run daily backup",
        estimatedRuntimeMs: 5000,
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });

    it("rejects missing estimatedRuntimeMs", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31T23:59:59Z",
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });

    it("rejects invalid datetime format", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31",
        estimatedRuntimeMs: 5000,
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });

    it("rejects non-positive estimatedRuntimeMs", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 0,
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });

    it("rejects negative estimatedRuntimeMs", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: -1000,
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });

    it("rejects invalid recurring type", () => {
      const input = {
        description: "Run daily backup",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: 5000,
        recurring: {
          type: "invalid",
        },
      };
      expect(() => ScheduleInput.parse(input)).toThrow();
    });
  });
});
