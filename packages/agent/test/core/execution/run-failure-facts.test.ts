import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { Bus } from "../../../src/index";
import { runAgent } from "../../../src/core/execution/run";
import { failureFacts } from "../../../src/core/retry";
import type { PolicyEngineRegistration } from "../../../src/core/policy";
import { createMockLlmConfig, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/** Zero-backoff retry so the attempt ladder is exercised without waiting on it. */
const zeroBackoff: PolicyEngineRegistration = {
  kind: "point",
  name: "test-zero-backoff",
  pointIds: ["run.error.error"],
  effectCapabilities: { "run.error.error": ["run.retry_after"] },
  priority: 100,
  fn: () =>
    PolicyDecision.allow({
      policyId: "test.zero-backoff",
      effects: [{ type: "run.retry_after", delayMs: 0 }],
    }),
};

async function failingRun(errorMessage: string): Promise<unknown> {
  try {
    await runAgent(runInput([{ role: "user", content: "hi" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      middleware: [zeroBackoff],
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => ({ type: "error", error: { message: errorMessage, name: "Error" } }),
      }),
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the run to fail");
}

describe("terminal failure facts on the raised error", () => {
  it("carries the decided reason, spent attempts, and the ceiling", async () => {
    const error = await failingRun("transient blip");

    expect(failureFacts(error)).toEqual({
      reason: "transient_error",
      attempt: 3,
      maxAttempts: 3,
      llm: true,
    });
  });

  it("reports one attempt for a reason the policy never retries", async () => {
    const error = await failingRun("validation failed: unusable shape");

    expect(failureFacts(error)).toEqual({
      reason: "validation_error",
      attempt: 1,
      maxAttempts: 3,
      llm: true,
    });
  });

  it("leaves the error's own identity and message untouched", async () => {
    const error = await failingRun("transient blip");

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("transient blip");
    // Non-enumerable: nothing serializes the facts by accident.
    expect(Object.keys(error as object)).not.toContain("failureFacts");
    expect(JSON.stringify({ ...(error as object) })).toBe("{}");
  });

  it("does not mark a configuration failure as an LLM terminal", async () => {
    let thrown: unknown;
    try {
      await runAgent(runInput([{ role: "user", content: "hi" }]), {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        middleware: [zeroBackoff],
        llm: {
          resolveProviderModel: async () => {
            throw new Error("catalog invariant failed");
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(failureFacts(thrown)).toBeUndefined();
  });

  it("answers undefined for an error no agent run decided", () => {
    expect(failureFacts(new Error("unrelated"))).toBeUndefined();
    expect(failureFacts(undefined)).toBeUndefined();
    expect(failureFacts("a string throw")).toBeUndefined();
  });
});
