import { describe, expect, it } from "bun:test";
import type { CanonicalPolicyRegistrationGeneric } from "@openomni/policy";
import type { Run } from "@openomni/llm";
import type { Message } from "@openomni/protocol";
import { PolicyDecision } from "@openomni/protocol";
import { runAgent } from "../../../src/core/execution/run";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { ChatAgentConfig } from "../../../src/core/types";
import { createMockLlmConfig, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";
import { Bus } from "@openomni/telemetry";

function assistantMessage(outputTokens: number): Message.WithParts {
  const id = `assistant-${outputTokens}`;
  const sessionID = "audit-session";
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: mockProviderModel.id,
      providerID: mockProviderModel.providerID,
      agent: "audit",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: {
        input: 0,
        output: outputTokens,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [{ id: `part-${outputTokens}`, sessionID, messageID: id, type: "text", text: "ok" }],
  };
}

describe("canonical lifecycle audit facts", () => {
  it("reports output tokens for the current LLM response rather than the whole run", async () => {
    // Given
    const responseTokens: number[] = [];
    let callCount = 0;
    const observer = {
      kind: "point",
      name: "test:llm-response-audit",
      pointIds: ["connection.llm.post"],
      effectCapabilities: { "connection.llm.post": [] },
      priority: 1,
      fn: (ctx) => {
        const currentResponseTokens = Reflect.get(ctx, "responseTokens");
        if (typeof currentResponseTokens !== "number") {
          throw new TypeError("connection.llm.post responseTokens must be numeric");
        }
        responseTokens.push(currentResponseTokens);
        return PolicyDecision.allow({ policyId: "test.llm-response-audit" });
      },
    } satisfies CanonicalPolicyRegistrationGeneric<PolicyContext>;
    const outcomes: readonly Run.Outcome[] = [{ type: "continue" }, { type: "stop" }];
    const config: ChatAgentConfig = {
      events: Bus,
      model: { provider: "test", id: "model" },
      middleware: [observer],
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async (_input, sink) => {
          const currentCall = callCount;
          callCount += 1;
          sink.onMessage(assistantMessage(currentCall === 0 ? 3 : 4));
          return outcomes[currentCall] ?? { type: "stop" };
        },
      }),
    };

    // When
    // The lifecycle observer is the asserted output.
    await runAgent(runInput([{ role: "user", content: "continue once" }]), config);

    // Then
    expect(responseTokens).toEqual([3, 4]);
  });
});
