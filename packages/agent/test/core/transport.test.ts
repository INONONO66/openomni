import { createTestAgent } from "../helpers/test-agent";
import { describe, expect, it } from "bun:test";
import type { RunInput } from "@openomni/llm";
import { collector } from "../../src/index";
import { completeModel, mockProviderModel } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

function transportHarness(transport?: RunInput["transport"]) {
  const seen: Array<RunInput["transport"]> = [];
  const agent = createTestAgent({
    events: collector(),
    model: { provider: "anthropic", id: mockProviderModel.id },
    ...(transport === undefined ? {} : { transport }),
    llm: {
      resolveModel: async () => mockProviderModel,
      run: async (input, sink) => {
        seen.push(input.transport);
        return completeModel(input, sink);
      },
    },
  });
  return { agent, seen };
}

describe("operator transport config threading", () => {
  it("hands the configured baseUrl and headers to the llm call", async () => {
    const transport = {
      baseUrl: "https://gateway.internal/v1",
      headers: { "x-tenant": "acme" },
    };
    const { agent, seen } = transportHarness(transport);
    await agent.run(runInput([{ role: "user", content: "hi" }]));
    expect(seen).toEqual([transport]);
  });

  it("leaves transport absent when the host configured none", async () => {
    const { agent, seen } = transportHarness();
    await agent.run(runInput([{ role: "user", content: "hi" }]));
    expect(seen).toEqual([undefined]);
  });
});
