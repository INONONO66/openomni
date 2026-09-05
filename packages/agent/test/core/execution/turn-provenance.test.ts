import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { runAgent } from "../../../src/core/execution/run";
import { Bus } from "../../../src/index";
import { createMockLlmConfig, createStopOutcome, mockProviderData, mockProviderModel } from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

describe("turn provenance", () => {
  it("preserves hydrated assistant role and parent linkage in model history", async () => {
    let messages: readonly Message.WithParts[] = [];
    await runAgent(
      runInput([
        { role: "user", content: "parent request" },
        { role: "assistant", content: "child result" },
      ]),
      {
        events: Bus,
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        llm: createMockLlmConfig({
          getModels: async () => mockProviderData,
          fromModelsDevModel: () => mockProviderModel,
          run: async (input) => { messages = [...(input.messages as readonly Message.WithParts[])]; return createStopOutcome(); },
        }),
      },
    );
    expect(messages.at(-1)?.info).toMatchObject({
      role: "assistant",
      parentID: messages.at(-2)?.info.id,
    });
    expect(messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "child result" });
  });
});
