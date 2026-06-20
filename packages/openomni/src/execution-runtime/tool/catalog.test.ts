import { describe, expect, test } from "bun:test";
import { buildToolCatalog, resolveCategory, resolveToolSelection } from "./catalog.js";
import type { NativeTool } from "./types.js";

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

const CATALOG_FIXTURE = buildToolCatalog([
  {
    source: "system",
    tools: [makeTool("read"), makeTool("write"), makeTool("bash")],
  },
  {
    source: "mcp",
    tools: [makeTool("some-mcp-tool")],
  },
  {
    source: "agent",
    tools: [makeTool("dispatch"), makeTool("custom-agent-tool")],
  },
]);

describe("buildToolCatalog", () => {
  test("throws on duplicate canonical name", () => {
    expect(() =>
      buildToolCatalog([
        { source: "system", tools: [makeTool("read")] },
        { source: "mcp", tools: [makeTool("read")] },
      ]),
    ).toThrow('Duplicate canonical tool name: "read"');
  });

  test("assigns correct categories from DEFAULT_CATEGORY_MAP", () => {
    const entries = buildToolCatalog([
      { source: "system", tools: [makeTool("bash"), makeTool("read"), makeTool("dispatch")] },
    ]);
    expect(entries.find((e) => e.canonicalName === "bash")?.category).toBe("execution");
    expect(entries.find((e) => e.canonicalName === "read")?.category).toBe("filesystem");
    expect(entries.find((e) => e.canonicalName === "dispatch")?.category).toBe("delegation");
  });
});

describe("resolveCategory", () => {
  test("explicit category takes priority", () => {
    expect(resolveCategory("bash", "system", "custom")).toBe("custom");
  });

  test("DEFAULT_CATEGORY_MAP is used for known names", () => {
    expect(resolveCategory("read", "system")).toBe("filesystem");
    expect(resolveCategory("write", "system")).toBe("filesystem");
    expect(resolveCategory("edit", "system")).toBe("filesystem");
    expect(resolveCategory("glob", "system")).toBe("filesystem");
    expect(resolveCategory("grep.search", "system")).toBe("filesystem");
    expect(resolveCategory("bash", "system")).toBe("execution");
    expect(resolveCategory("dispatch", "agent")).toBe("delegation");
  });

  test("mcp source defaults to 'mcp' for unknown names", () => {
    expect(resolveCategory("some-unknown-tool", "mcp")).toBe("mcp");
  });

  test("non-mcp unknown names default to 'custom'", () => {
    expect(resolveCategory("unknown", "system")).toBe("custom");
    expect(resolveCategory("unknown", "agent")).toBe("custom");
  });
});

describe("resolveToolSelection", () => {
  test("categories filter selects matching entries", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, { categories: ["filesystem"] });
    expect(result.map((e) => e.canonicalName)).toEqual(["read", "write"]);
  });

  test("all:true selects the full catalog", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, { all: true });
    expect(result).toHaveLength(CATALOG_FIXTURE.length);
  });

  test("empty selection returns empty list", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, {});
    expect(result).toHaveLength(0);
  });

  test("allow adds tools not in base set", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, {
      categories: ["filesystem"],
      allow: ["bash"],
    });
    const names = result.map((e) => e.canonicalName);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("bash");
  });

  test("depth 1 removes delegation category", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, { all: true }, undefined, 1);
    expect(result.some((e) => e.category === "delegation")).toBe(false);
    expect(result.some((e) => e.category === "execution")).toBe(true);
  });

  test("depth 2 removes delegation and execution categories", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, { all: true }, undefined, 2);
    expect(result.some((e) => e.category === "delegation")).toBe(false);
    expect(result.some((e) => e.category === "execution")).toBe(false);
    expect(result.some((e) => e.category === "filesystem")).toBe(true);
  });

  test("deny removes specific tools from result", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, {
      categories: ["filesystem"],
      deny: ["write"],
    });
    const names = result.map((e) => e.canonicalName);
    expect(names).toContain("read");
    expect(names).not.toContain("write");
  });

  test("categories + deny combination filters correctly", () => {
    const result = resolveToolSelection(CATALOG_FIXTURE, {
      categories: ["filesystem", "execution"],
      deny: ["bash"],
    });
    const names = result.map((e) => e.canonicalName);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).not.toContain("bash");
  });

  test("parentAllowed intersects with result", () => {
    const parent = new Set(["read"]);
    const result = resolveToolSelection(CATALOG_FIXTURE, { categories: ["filesystem"] }, parent);
    expect(result.map((e) => e.canonicalName)).toEqual(["read"]);
  });
});
