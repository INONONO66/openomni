import { describe, expect, it } from "bun:test";
import { runTestAgent } from "../../helpers/test-agent";
import { failureFacts } from "../../../src/core/retry";
import { Bus } from "../../../src/index";
import { providerFailure, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

async function failedRun(failure: Error) {
  let calls = 0;
  const result = await runTestAgent(runInput([{ role: "user", content: "hi" }]), {
    events: Bus,
    model: { provider: "anthropic", id: mockProviderModel.id },
    llm: {
      resolveModel: async () => mockProviderModel,
      run: async () => {
        calls += 1;
        throw failure;
      },
    },
  }).catch((error: Error) => error);
  return { result, calls };
}

describe("terminal failure facts", () => {
  it("carries canonical classification, spent attempts and ceiling", async () => {
    const failure = providerFailure("opaque failure");
    const { result, calls } = await failedRun(failure);
    expect(result).toBe(failure);
    expect(calls).toBe(3);
    expect(failureFacts(result)).toEqual({
      reason: "transient_error",
      attempt: 3,
      maxAttempts: 3,
      llm: true,
    });
  });
  it("keeps nonretryable provider failures at one attempt", async () => {
    const { result, calls } = await failedRun(
      providerFailure("invalid request", { retryable: false, statusCode: 400 }),
    );
    expect(calls).toBe(1);
    expect(failureFacts(result)).toEqual({
      reason: "validation_error",
      attempt: 1,
      maxAttempts: 3,
      llm: true,
    });
  });
  it("does not add enumerable provenance or change the provider error identity", async () => {
    const failure = providerFailure("failure");
    const original = JSON.stringify(failure);
    expect((await failedRun(failure)).result).toBe(failure);
    expect(JSON.stringify(failure)).toBe(original);
    expect(
      Object.getOwnPropertyDescriptor(failure, Symbol.for("openomni.agent.failureFacts"))
        ?.enumerable,
    ).toBe(false);
  });
  it("does not attribute catalog, policy, storage or unrelated failures to the provider", async () => {
    const failure = new Error("catalog invariant failed");
    const result = await runTestAgent(runInput([{ role: "user", content: "hi" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "model" },
      llm: {
        resolveModel: async () => {
          throw failure;
        },
      },
    }).catch((error: Error) => error);
    expect(result).toBe(failure);
    expect(failureFacts(result)).toBeUndefined();
    expect(failureFacts(undefined)).toBeUndefined();
    expect(failureFacts("non-Error")).toBeUndefined();
  });
});
