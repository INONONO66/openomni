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
    ).toEqual(["web_fetch", "web_search"]);
  });

  it("keeps mock tools out of the production catalog (#521 weather_lookup regression)", () => {
    // Enforcement layer: the no-arg CustomToolProvider surfaces ONLY
    // createOpenSearchNativeTools(). A mock (e.g. the former `weather_lookup`)
    // must never be baked into the default catalog — the sole injection path is
    // the `extraTools` constructor seam. This fails if a mock is re-added to
    // provider.ts's default tools.
    const defaultNames = new CustomToolProvider().listTools().map((tool) => tool.spec.name);
    expect(defaultNames).not.toContain("weather_lookup");

    const withInjectedStub = new CustomToolProvider([makeTool("weather_lookup")]);
    expect(withInjectedStub.listTools().map((tool) => tool.spec.name)).toContain("weather_lookup");
  });

  it("rejects extra tools that duplicate opensearch defaults", () => {
    expect(() => new CustomToolProvider([makeTool("web_search")])).toThrow(
      "Duplicate custom tool name: web_search",
    );
  });
});
