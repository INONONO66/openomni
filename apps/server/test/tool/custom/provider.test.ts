import { describe, expect, it } from "bun:test";
import type { NativeTool } from "@openomni/openomni";
import { CustomToolProvider } from "../../../src/tool/custom";

function makeTool(name: string): NativeTool {
  return {
    spec: { name, description: `${name} tool`, inputSchema: {} },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: "ok",
    }),
  };
}

describe("CustomToolProvider", () => {
  it("exposes opensearch AI SDK tools by default", () => {
    const provider = new CustomToolProvider();

    expect(
      provider
        .listTools()
        .map((tool) => tool.spec.name)
        .sort(),
    ).toEqual(["weather_lookup", "web_fetch", "web_search"]);
  });

  it("rejects extra tools that duplicate opensearch defaults", () => {
    expect(() => new CustomToolProvider([makeTool("web_search")])).toThrow(
      "Duplicate custom tool name: web_search",
    );
  });
});
