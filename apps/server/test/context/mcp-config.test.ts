import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpConfigLoader } from "../../src/context/mcp-config";

type McpServerConfig = {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
};

let tempRoot: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "mcp-config-test-")));
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("McpConfigLoader.discover", () => {
  it("returns null when .openomni/mcp.json does not exist", () => {
    const dir = join(tempRoot, "empty-workspace");
    mkdirSync(dir, { recursive: true });
    expect(McpConfigLoader.discover(dir)).toBeNull();
  });

  it("reads servers from { servers: [...] } format", () => {
    const dir = join(tempRoot, "object-format");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });

    const servers: McpServerConfig[] = [
      { name: "server-a", transport: "stdio", command: "node", args: ["a.js"] },
    ];
    writeFileSync(join(openomniDir, "mcp.json"), JSON.stringify({ servers }), "utf-8");

    const result = McpConfigLoader.discover(dir);
    expect(result).toEqual(servers);
  });

  it("reads servers from [...] array format directly", () => {
    const dir = join(tempRoot, "array-format");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });

    const servers: McpServerConfig[] = [
      { name: "server-b", transport: "sse", url: "http://localhost:8080" },
    ];
    writeFileSync(join(openomniDir, "mcp.json"), JSON.stringify(servers), "utf-8");

    const result = McpConfigLoader.discover(dir);
    expect(result).toEqual(servers);
  });

  it("returns null on malformed JSON without crashing", () => {
    const dir = join(tempRoot, "bad-json");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });
    writeFileSync(join(openomniDir, "mcp.json"), "{ not valid json", "utf-8");

    expect(McpConfigLoader.discover(dir)).toBeNull();
  });
});

describe("McpConfigLoader.merge", () => {
  const globalServers: McpServerConfig[] = [
    { name: "global-a", transport: "stdio", command: "ga" },
    { name: "global-b", transport: "sse", url: "http://gb" },
  ];

  const projectServers: McpServerConfig[] = [
    { name: "project-c", transport: "stdio", command: "pc" },
  ];

  it("returns global unchanged when project is null", () => {
    expect(McpConfigLoader.merge(globalServers, null)).toEqual(globalServers);
  });

  it("includes both global and project servers when no name conflict", () => {
    const result = McpConfigLoader.merge(globalServers, projectServers);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toContain("global-a");
    expect(result.map((s) => s.name)).toContain("global-b");
    expect(result.map((s) => s.name)).toContain("project-c");
  });

  it("project server overrides global on name conflict", () => {
    const conflictProject: McpServerConfig[] = [
      { name: "global-a", transport: "sse", url: "http://override" },
    ];
    const result = McpConfigLoader.merge(globalServers, conflictProject);

    const overridden = result.find((s) => s.name === "global-a");
    expect(overridden?.transport).toBe("sse");
    expect(overridden?.url).toBe("http://override");
    expect(overridden?.command).toBeUndefined();
  });

  it("returns project servers when global is empty", () => {
    expect(McpConfigLoader.merge([], projectServers)).toEqual(projectServers);
  });

  it("returns global servers when project is empty", () => {
    expect(McpConfigLoader.merge(globalServers, [])).toEqual(globalServers);
  });
});
