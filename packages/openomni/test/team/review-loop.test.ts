import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PlanStep } from "@openomni/protocol";
import type { Message, Run, Sink } from "@openomni/protocol";

// --- Mock setup (must be before dynamic import) ---

type MockLlmFn = (input: any, sink: Sink) => Promise<Run.Outcome>;

let mockRunFn: MockLlmFn = async () => ({ type: "stop" });

const mockModelsGet = mock(async () => ({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-haiku-20240307": {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
      },
    },
  },
}));

const mockProviderFromModelsDevModel = mock(() => ({
  id: "claude-3-haiku-20240307",
  providerID: "anthropic",
}));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: (input: any, sink: Sink) => mockRunFn(input, sink),
}));

// --- Dynamic import after mock ---

let ReviewLoop: typeof import("../../src/team/review-loop").ReviewLoop;

beforeAll(async () => {
  ({ ReviewLoop } = await import("../../src/team/review-loop"));
});

// --- Helpers ---

function createAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "review-test";
  const now = Date.now();
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "chat-agent",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 10,
      output: 5,
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

function setupMockResponse(text: string) {
  mockRunFn = async (_input: any, sink: Sink) => {
    sink.onMessage(createAssistantMessage(text));
    return { type: "stop" } as Run.Outcome;
  };
}

// --- Fixtures ---

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

// --- Tests ---

describe("ReviewLoop", () => {
  beforeEach(() => {
    mockRunFn = async () => ({ type: "stop" }) as Run.Outcome;
    mockModelsGet.mockClear();
    mockProviderFromModelsDevModel.mockClear();
  });

  describe("review", () => {
    it("returns accept decision when LLM accepts", async () => {
      setupMockResponse(JSON.stringify({ decision: "accept" }));

      const output = await ReviewLoop.review(defaultInput, defaultConfig);

      expect(output.decision).toBe("accept");
      expect(output.feedback).toBeUndefined();
    });

    it("returns reject decision with feedback", async () => {
      setupMockResponse(
        JSON.stringify({
          decision: "reject",
          feedback: "Missing error handling",
        }),
      );

      const output = await ReviewLoop.review(defaultInput, defaultConfig);

      expect(output.decision).toBe("reject");
      expect(output.feedback).toBe("Missing error handling");
    });

    it("throws when LLM returns invalid JSON", async () => {
      setupMockResponse("This is definitely not JSON");

      await expect(
        ReviewLoop.review(defaultInput, defaultConfig),
      ).rejects.toThrow(/failed to parse/i);
    });

    it("includes guardrail in review prompt when step has guardrail", async () => {
      let capturedInput: any;
      mockRunFn = async (input: any, sink: Sink) => {
        capturedInput = input;
        sink.onMessage(
          createAssistantMessage(JSON.stringify({ decision: "accept" })),
        );
        return { type: "stop" } as Run.Outcome;
      };

      const stepWithGuardrail: PlanStep = {
        ...defaultStep,
        guardrail: "Must not expose user passwords in logs",
      };

      await ReviewLoop.review(
        { ...defaultInput, step: stepWithGuardrail },
        defaultConfig,
      );

      // The user message (first in messages array) should contain the guardrail
      const messages = capturedInput.messages as Message.WithParts[];
      const userMsg = messages[0];
      const textPart = userMsg.parts.find(
        (p: Message.Part) => p.type === "text",
      ) as Message.TextPart | undefined;
      expect(textPart?.text).toContain(
        "Must not expose user passwords in logs",
      );
    });
  });

  describe("shouldHandoff", () => {
    it("returns true when at max attempts", () => {
      expect(ReviewLoop.shouldHandoff(3, 3)).toBe(true);
    });

    it("returns true at penultimate attempt (handoff before final retry)", () => {
      // Fix for off-by-one: handoff triggers at maxAttempts - 1
      // so the final retry gets a handoff document
      expect(ReviewLoop.shouldHandoff(2, 3)).toBe(true);
    });

    it("returns false when well below max attempts", () => {
      expect(ReviewLoop.shouldHandoff(1, 3)).toBe(false);
    });

    it("returns true on first attempt with max=2 (penultimate = first)", () => {
      // With max=2, attempt 1 is the penultimate, so handoff triggers
      expect(ReviewLoop.shouldHandoff(1, 2)).toBe(true);
    });

    it("returns true on first attempt with max=1 (immediate handoff)", () => {
      expect(ReviewLoop.shouldHandoff(1, 1)).toBe(true);
    });
  });

  describe("generateHandoff", () => {
    it("returns a non-empty handoff document", async () => {
      setupMockResponse(
        "## Handoff Document\n\nThe login feature was rejected because...",
      );

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
