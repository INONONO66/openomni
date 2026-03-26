import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import type { PlanStep } from "@openomni/protocol";
import { ReviewLoop } from "../../src/team/review-loop";

const originalCreate = ChatAgent.create;
const createSpy = spyOn(ChatAgent, "create");

function makeAgentResult(text: string): AgentResult {
  return {
    text,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  };
}

let capturedInput: ChatAgentInput | undefined;
let runImpl = mock(async (input: ChatAgentInput) => {
  capturedInput = input;
  return makeAgentResult("{}");
});

beforeEach(() => {
  capturedInput = undefined;
  runImpl = mock(async (input: ChatAgentInput) => {
    capturedInput = input;
    return makeAgentResult("{}");
  });

  createSpy.mockImplementation((config) => {
    const realAgent = originalCreate(config);
    return {
      ...realAgent,
      run: async (input: ChatAgentInput) => {
        const firstMessage = input.messages[0]?.content ?? "";
        if (
          firstMessage.includes("You are reviewing the output of a task execution") ||
          firstMessage.includes(
            "Generate a handoff document for the following failed task execution",
          )
        ) {
          return runImpl(input);
        }
        return realAgent.run(input);
      },
    };
  });
});

afterAll(() => {
  createSpy.mockRestore();
});

const defaultConfig = {
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
};

const defaultStep: PlanStep = {
  stepId: "step-1",
  description: "Implement the login feature",
  expectedOutput: "A working login page with email/password fields",
  dependsOn: [],
};

const defaultInput = {
  step: defaultStep,
  result: "Created login page with email and password fields.",
  agentId: "agent-coder",
  attemptNumber: 1,
};

describe("ReviewLoop", () => {
  describe("review", () => {
    it("returns accept decision when LLM accepts", async () => {
      runImpl = mock(async (input: ChatAgentInput) => {
        capturedInput = input;
        return makeAgentResult(JSON.stringify({ decision: "accept" }));
      });

      const output = await ReviewLoop.review(defaultInput, defaultConfig);

      expect(output.decision).toBe("accept");
      expect(output.feedback).toBeUndefined();
    });

    it("returns reject decision with feedback", async () => {
      runImpl = mock(async (input: ChatAgentInput) => {
        capturedInput = input;
        return makeAgentResult(
          JSON.stringify({
            decision: "reject",
            feedback: "Missing error handling",
          }),
        );
      });

      const output = await ReviewLoop.review(defaultInput, defaultConfig);

      expect(output.decision).toBe("reject");
      expect(output.feedback).toBe("Missing error handling");
    });

    it("throws when LLM returns invalid JSON", async () => {
      runImpl = mock(async (input: ChatAgentInput) => {
        capturedInput = input;
        return makeAgentResult("This is definitely not JSON");
      });

      await expect(ReviewLoop.review(defaultInput, defaultConfig)).rejects.toThrow(
        /failed to parse/i,
      );
    });

    it("includes guardrail in review prompt when step has guardrail", async () => {
      runImpl = mock(async (input: ChatAgentInput) => {
        capturedInput = input;
        return makeAgentResult(JSON.stringify({ decision: "accept" }));
      });

      const stepWithGuardrail: PlanStep = {
        ...defaultStep,
        guardrail: "Must not expose user passwords in logs",
      };

      await ReviewLoop.review({ ...defaultInput, step: stepWithGuardrail }, defaultConfig);

      const prompt = capturedInput?.messages[0]?.content;
      expect(prompt).toContain("Must not expose user passwords in logs");
    });
  });

  describe("shouldHandoff", () => {
    it("returns true when at max attempts", () => {
      expect(ReviewLoop.shouldHandoff(3, 3)).toBe(true);
    });

    it("returns true at penultimate attempt (handoff before final retry)", () => {
      expect(ReviewLoop.shouldHandoff(2, 3)).toBe(true);
    });

    it("returns false when well below max attempts", () => {
      expect(ReviewLoop.shouldHandoff(1, 3)).toBe(false);
    });

    it("returns true on first attempt with max=2 (penultimate = first)", () => {
      expect(ReviewLoop.shouldHandoff(1, 2)).toBe(true);
    });

    it("returns true on first attempt with max=1 (immediate handoff)", () => {
      expect(ReviewLoop.shouldHandoff(1, 1)).toBe(true);
    });
  });

  describe("generateHandoff", () => {
    it("returns a non-empty handoff document", async () => {
      runImpl = mock(async (input: ChatAgentInput) => {
        capturedInput = input;
        return makeAgentResult("## Handoff Document\n\nThe login feature was rejected because...");
      });

      const handoff = await ReviewLoop.generateHandoff(
        defaultInput,
        "Missing error handling for invalid credentials",
        defaultConfig,
      );

      expect(handoff).toBeTruthy();
      expect(handoff.length).toBeGreaterThan(0);
    });
  });
});
