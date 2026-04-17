import { describe, expect, test } from "bun:test";
import { buildToolCatalog, resolveToolSelection } from "../../catalog.js";
import type { NativeTool } from "../../types.js";

function makeTool(name: string): NativeTool {
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    execute: async () => ({ id: crypto.randomUUID(), toolCallId: "test", output: "ok" }),
  };
}

const FIXTURE_CATALOG = buildToolCatalog([
  { source: "system", tools: [makeTool("read"), makeTool("bash")] },
  { source: "agent", tools: [makeTool("subagent")] },
  { source: "mcp", tools: [makeTool("mcp-search")] },
]);

describe("depth-based child tool filtering", () => {
  test("depth 0 has all tools including delegation and execution", () => {
    const result = resolveToolSelection(FIXTURE_CATALOG, { all: true }, undefined, 0);
    const names = result.map((e) => e.canonicalName);
    expect(names).toContain("subagent");
    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(names).toContain("mcp-search");
  });

  test("depth 1 has no delegation tools (no subagent)", () => {
    const result = resolveToolSelection(FIXTURE_CATALOG, { all: true }, undefined, 1);
    const names = result.map((e) => e.canonicalName);
    expect(names).not.toContain("subagent");
    expect(names).toContain("bash");
    expect(names).toContain("read");
  });

  test("depth 2 has no delegation or execution tools", () => {
    const result = resolveToolSelection(FIXTURE_CATALOG, { all: true }, undefined, 2);
    const names = result.map((e) => e.canonicalName);
    expect(names).not.toContain("subagent");
    expect(names).not.toContain("bash");
    expect(names).toContain("read");
    expect(names).toContain("mcp-search");
  });

  test("depth 1 filtering respects parentAllowed intersection", () => {
    const parentAllowed = new Set(["read", "subagent"]);
    const result = resolveToolSelection(FIXTURE_CATALOG, { all: true }, parentAllowed, 1);
    const names = result.map((e) => e.canonicalName);
    expect(names).not.toContain("subagent");
    expect(names).toContain("read");
    expect(names).not.toContain("bash");
  });
});
