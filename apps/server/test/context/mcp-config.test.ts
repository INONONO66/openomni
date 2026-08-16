import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Operational, type McpServerConfig } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { McpConfigLoader } from "../../src/context/mcp-config";

/** Discovery runs during boot and reports under the boot's trace. */
const TEST_BOOT_TRACE_ID = "trace-boot-test";

let tempRoot: string;

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "mcp-config-test-")));
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  Bus.reset();
});

describe("McpConfigLoader.discover", () => {
  it("returns null when .openomni/mcp.json does not exist", () => {
    const dir = join(tempRoot, "empty-workspace");
    mkdirSync(dir, { recursive: true });
    expect(McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID)).toBeNull();
  });

  it("reads servers from { servers: [...] } format", () => {
    const dir = join(tempRoot, "object-format");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });

    const servers: McpServerConfig[] = [
      { name: "server-a", transport: "stdio", command: "node", args: ["a.js"] },
    ];
    writeFileSync(join(openomniDir, "mcp.json"), JSON.stringify({ servers }), "utf-8");

    const result = McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID);
    expect(result).toEqual(servers);
  });

  it("reads servers from [...] array format directly", () => {
    const dir = join(tempRoot, "array-format");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });

    const servers: McpServerConfig[] = [
      {
        name: "server-b",
        transport: "sse",
        url: "http://localhost:8080",
        headers: { Authorization: "Bearer project-token" },
        timeout: 5_000,
        retries: 1,
      },
    ];
    writeFileSync(join(openomniDir, "mcp.json"), JSON.stringify(servers), "utf-8");

    const result = McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID);
    expect(result).toEqual(servers);
  });

  it("returns null on malformed JSON without crashing", () => {
    const dir = join(tempRoot, "bad-json");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });
    writeFileSync(join(openomniDir, "mcp.json"), "{ not valid json", "utf-8");

    expect(McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID)).toBeNull();
  });

  it("drops invalid server entries through the protocol MCP schema", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (payload) => warnings.push(payload));
    const dir = join(tempRoot, "invalid-server-entry");
    const openomniDir = join(dir, ".openomni");
    const configPath = join(openomniDir, "mcp.json");
    mkdirSync(openomniDir, { recursive: true });
    const valid: McpServerConfig = { name: "valid", transport: "stdio", command: "node" };
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: [valid, { name: "bad", transport: "websocket", url: "ws://localhost" }],
      }),
      "utf-8",
    );

    expect(McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID)).toEqual([valid]);
    await flushBus();
    unsubscribe();
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid mcp server config ignored",
        context: expect.objectContaining({
          source: "project-config",
          configPath,
          rejected: [expect.objectContaining({ index: 1, name: "bad" })],
        }),
      }),
    );
  });

  it("routes non-array object-format servers through the shared parser", async () => {
    const warnings: unknown[] = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (payload) => warnings.push(payload));
    const dir = join(tempRoot, "object-format-non-array");
    const openomniDir = join(dir, ".openomni");
    const configPath = join(openomniDir, "mcp.json");
    mkdirSync(openomniDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ servers: { name: "bad", transport: "stdio" } }),
      "utf-8",
    );

    expect(McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID)).toEqual([]);
    await flushBus();
    unsubscribe();
    expect(warnings).toContainEqual(
      expect.objectContaining({
        msg: "invalid mcp server config ignored",
        context: expect.objectContaining({
          source: "project-config",
          configPath,
          rejected: [expect.objectContaining({ index: -1, error: "servers must be an array" })],
        }),
      }),
    );
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
    expect(overridden).toEqual({ name: "global-a", transport: "sse", url: "http://override" });
  });

  it("project overrides preserve protocol MCP fields", () => {
    const conflictProject: McpServerConfig[] = [
      {
        name: "global-b",
        transport: "streamable-http",
        url: "https://override.example.com",
        headers: { "x-project": "yes" },
        timeout: 9_000,
        retries: 3,
      },
    ];

    const result = McpConfigLoader.merge(globalServers, conflictProject);
    expect(result.find((s) => s.name === "global-b")).toEqual(conflictProject[0]);
  });

  it("returns project servers when global is empty", () => {
    expect(McpConfigLoader.merge([], projectServers)).toEqual(projectServers);
  });

  it("returns global servers when project is empty", () => {
    expect(McpConfigLoader.merge(globalServers, [])).toEqual(globalServers);
  });
});

describe("McpConfigLoader caching", () => {
  it("discover returns cached result on repeated calls", () => {
    const dir = join(tempRoot, "cache-repeat");
    const openomniDir = join(dir, ".openomni");
    mkdirSync(openomniDir, { recursive: true });
    writeFileSync(
      join(openomniDir, "mcp.json"),
      JSON.stringify([{ name: "s1", transport: "stdio", command: "node" }]),
    );

    const first = McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID);
    const second = McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
  });

  it("discover caches null for missing config for the same workspace path", () => {
    const dir = join(tempRoot, "cache-null");
    mkdirSync(dir, { recursive: true });

    const first = McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID);
    expect(first).toBeNull();

    // create config after initial call — still returns null from cache
    mkdirSync(join(dir, ".openomni"), { recursive: true });
    writeFileSync(
      join(dir, ".openomni", "mcp.json"),
      JSON.stringify([{ name: "late", transport: "stdio", command: "node" }]),
    );

    const cached = McpConfigLoader.discover(dir, TEST_BOOT_TRACE_ID);
    expect(cached).toBeNull();

    const freshDir = join(tempRoot, "cache-null-fresh");
    mkdirSync(join(freshDir, ".openomni"), { recursive: true });
    writeFileSync(
      join(freshDir, ".openomni", "mcp.json"),
      JSON.stringify([{ name: "late", transport: "stdio", command: "node" }]),
    );

    const fresh = McpConfigLoader.discover(freshDir, TEST_BOOT_TRACE_ID);
    expect(fresh).toHaveLength(1);
  });
});
