import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverSrc = join(import.meta.dir, "../../src");

describe("context barrel export", () => {
  it("exports only production-facing context entrypoints", async () => {
    const mod = await import("../../src/context/index");

    expect(Object.keys(mod).sort()).toEqual(["McpConfigLoader", "createContextMiddleware"]);
    expect(typeof mod.createContextMiddleware).toBe("function");
    expect(typeof mod.McpConfigLoader).toBe("object");
    expect(typeof mod.McpConfigLoader.discover).toBe("function");
    expect(typeof mod.McpConfigLoader.merge).toBe("function");
  });
});

describe("worker authenticated context wiring", () => {
  const workerRunnerSrc = readFileSync(join(serverSrc, "execution/worker-runner.ts"), "utf-8");

  it("uses only the authenticated runtime prompt and policy middleware", () => {
    expect(workerRunnerSrc).not.toContain("createContextMiddleware");
    expect(workerRunnerSrc).not.toContain("SessionBridge");
    expect(workerRunnerSrc).toContain("buildWorkerMiddleware(");
    expect(workerRunnerSrc).toContain("systemPrompt: agent.systemPrompt");
  });
});

describe("bootstrap/index.ts MCP config merging", () => {
  const bootstrapSrc = readFileSync(join(serverSrc, "bootstrap/index.ts"), "utf-8");

  it("imports McpConfigLoader from context/index", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader");
    expect(bootstrapSrc).toContain("../context/index");
  });

  it("calls McpConfigLoader.discover", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader.discover(");
  });

  it("calls McpConfigLoader.merge", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader.merge(");
  });
});
