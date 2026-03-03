import { describe, it, expect } from "bun:test";
import { ConversationHandler, RequestContext } from "../../../src/legacy/conversation";

describe("ConversationHandler", () => {
  describe("decide", () => {
    it("returns 'task' when needsApproval is true (Heuristic 1)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: true,
        userIntent: "Add login feature",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toBe("Needs design review or approval");
    });

    it("returns 'task' when user says 'later' (Heuristic 2)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "Do this later when you have time",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("deferred execution");
    });

    it("returns 'task' when user says 'when you have time' (Heuristic 2)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "when you have time, refactor this",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("deferred execution");
    });

    it("returns 'task' when user says 'create PR' (Heuristic 3)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "Create PR for this feature",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("Complex work request");
    });

    it("returns 'task' when user says 'implement feature' (Heuristic 3)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "Implement feature X",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("Complex work request");
    });

    it("returns 'task' when fileCount > 3 (Heuristic 4)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 5,
        needsApproval: false,
        userIntent: "Update multiple modules",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toBe(
        "Requires file writes across multiple modules",
      );
    });

    it("returns 'inline' when estimatedDuration < 30s (Heuristic 5)", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 2,
        needsApproval: false,
        userIntent: "Rename variable",
        complexity: "trivial",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Estimated duration < 30s");
    });

    it("returns 'inline' when fileCount is 1 (Heuristic 6)", () => {
      const context: RequestContext = {
        estimatedDuration: 45000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "Update this file",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Single file edit");
    });

    it("returns 'inline' for question with 'what' (Heuristic 7)", () => {
      const context: RequestContext = {
        estimatedDuration: 50000,
        fileCount: 3,
        needsApproval: false,
        userIntent: "What does this function do?",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Question or lookup");
    });

    it("returns 'inline' for question with '?' (Heuristic 7)", () => {
      const context: RequestContext = {
        estimatedDuration: 50000,
        fileCount: 3,
        needsApproval: false,
        userIntent: "How does this work?",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Question or lookup");
    });

    it("returns 'inline' for lookup with 'find' (Heuristic 7)", () => {
      const context: RequestContext = {
        estimatedDuration: 50000,
        fileCount: 3,
        needsApproval: false,
        userIntent: "Find all usages of this function",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Question or lookup");
    });

    it("returns 'task' for long-running operation >= 30s with multiple files", () => {
      const context: RequestContext = {
        estimatedDuration: 120000,
        fileCount: 3,
        needsApproval: false,
        userIntent: "Refactor this module",
        complexity: "complex",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("Long-running operation");
    });

    it("returns 'task' for complex operation as fallback", () => {
      const context: RequestContext = {
        estimatedDuration: 25000,
        fileCount: 2,
        needsApproval: false,
        userIntent: "Refactor architecture",
        complexity: "complex",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toBe("Complex operation requiring checkpoints");
    });

    it("returns 'inline' for simple operation under 30s", () => {
      const context: RequestContext = {
        estimatedDuration: 25000,
        fileCount: 2,
        needsApproval: false,
        userIntent: "Update config",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Estimated duration < 30s");
    });

    it("prioritizes needsApproval over all other signals", () => {
      const context: RequestContext = {
        estimatedDuration: 5000,
        fileCount: 1,
        needsApproval: true,
        userIntent: "Quick fix",
        complexity: "trivial",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toBe("Needs design review or approval");
    });

    it("prioritizes deferred keywords over duration", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "Do this later",
        complexity: "trivial",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("deferred execution");
    });

    it("prioritizes task keywords over file count", () => {
      const context: RequestContext = {
        estimatedDuration: 10000,
        fileCount: 1,
        needsApproval: false,
        userIntent: "Implement feature X",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("task");
      expect(result.reason).toContain("Complex work request");
    });

    it("prioritizes question keywords over duration and file count", () => {
      const context: RequestContext = {
        estimatedDuration: 50000,
        fileCount: 3,
        needsApproval: false,
        userIntent: "Explain how this works",
        complexity: "simple",
      };

      const result = ConversationHandler.decide(context);

      expect(result.path).toBe("inline");
      expect(result.reason).toBe("Question or lookup");
    });
  });
});
