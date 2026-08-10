import { describe, expect, it } from "bun:test";
import { WorkerBootstrap } from "@openomni/protocol";
import type { AgentDefinition, AgentPromptMetadata } from "../../src/agents/types";

// Pins the sole server-to-worker agent egress boundary used by
// assembleBootstrap (bootstrap/worker-bootstrap.ts): protocol parsing
// projects the wire contract and strips server-only prompt metadata.
describe("runtime agent egress projection", () => {
  it("serializes server agent definitions through the protocol runtime schema", () => {
    const definition: AgentDefinition = {
      name: "dev",
      description: "Development agent",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      systemPrompt: "Build carefully.",
      tools: { categories: ["filesystem", "execution"] },
      policyPlan: {
        policies: [{ id: "builtin:tool-permission", required: true }],
        labels: ["dev-runtime"],
      },
      budget: { maxTurns: 4, maxToolCalls: 8 },
    };

    const runtime = WorkerBootstrap.RuntimeAgentDefinition.parse(definition);

    expect(runtime).toEqual(definition);
    expect(WorkerBootstrap.RuntimeAgentDefinition.parse(runtime)).toEqual(runtime);
  });

  it("keeps prompt metadata out of the worker bootstrap contract", () => {
    const metadata: AgentPromptMetadata = {
      name: "dev",
      description: "Development agent",
      triggers: { slashCommand: "dev" },
    };
    const definitionWithMetadata = {
      name: "dev",
      description: metadata.description,
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      systemPrompt: "Build carefully.",
      tools: { categories: ["filesystem"] },
      metadata,
    } as AgentDefinition & { metadata: AgentPromptMetadata };

    const runtime = WorkerBootstrap.RuntimeAgentDefinition.parse(definitionWithMetadata);

    expect(runtime).toEqual({
      name: "dev",
      description: "Development agent",
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      systemPrompt: "Build carefully.",
      tools: { categories: ["filesystem"] },
    });
    expect("metadata" in runtime).toBe(false);
  });
});
