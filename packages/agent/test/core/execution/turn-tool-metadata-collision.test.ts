import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { runAgent } from "../../../src/core/execution/run";
import type { ChatAgentConfig } from "../../../src/core/types";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/**
 * Tool metadata keys must be unambiguous (#606 re-audit): a tool named `a_b`
 * also claims the underscore-mangled alias `a.b`, so registering a second
 * tool literally named `a.b` used to silently hand the later tool's labels
 * to the earlier tool's policy lookups (last-writer-wins on a shared key).
 * The collision now refuses the run before it opens, naming both tools.
 */
function config(tools: NonNullable<ChatAgentConfig["tools"]>): ChatAgentConfig {
  return {
    events: Bus,
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    tools,
    toolExecutor: async (call) => ({
      id: "result-1",
      toolCallId: call.id,
      output: "ok",
      isError: false,
    }),
    llm: createMockLlmConfig({
      getModels: async () => mockProviderData,
      fromModelsDevModel: () => mockProviderModel,
      run: async () => createStopOutcome(),
    }),
  };
}

function spec(name: string) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" as const, properties: {} },
    labels: [`origin:${name}`],
  };
}

describe("tool metadata key collisions", () => {
  it("refuses a catalog where a_b's alias collides with a tool named a.b", async () => {
    await expect(
      runAgent(runInput([{ role: "user", content: "hi" }]), config([spec("a_b"), spec("a.b")])),
    ).rejects.toThrow('tool metadata collision: "a.b" is claimed by both "a_b" and "a.b"');
  });

  it("refuses two distinct tools carrying the same name (identity, not name, owns a key)", async () => {
    // The mangling seam can manufacture this: name-keyed ownership would see
    // "same name, no conflict" and let the later tool answer the earlier
    // tool's policy lookups.
    await expect(
      runAgent(runInput([{ role: "user", content: "hi" }]), config([spec("a.b"), spec("a.b")])),
    ).rejects.toThrow('tool metadata collision: "a.b" is claimed by both "a.b" and "a.b"');
  });

  it("a single tool claiming its own alias keys stays legal", async () => {
    const result = await runAgent(
      runInput([{ role: "user", content: "hi" }]),
      config([spec("a_b")]),
    );
    expect(result.finishReason).toBeDefined();
  });
});
