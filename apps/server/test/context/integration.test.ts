import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverSrc = join(import.meta.dir, "../../src");

describe("worker-entry wiring", () => {
  const workerRunnerSrc = readFileSync(join(serverSrc, "execution/worker-runner.ts"), "utf-8");

  it("worker runner imports createContextMiddleware from context/middleware", () => {
    expect(workerRunnerSrc).toContain("createContextMiddleware");
    expect(workerRunnerSrc).toContain("../context/middleware");
  });

  it("worker runner uses createContextMiddleware in middleware array", () => {
    expect(workerRunnerSrc).toContain("createContextMiddleware(");
    expect(workerRunnerSrc).toContain("...buildWorkerMiddleware(");
  });
});

describe("bootstrap/index.ts MCP config merging", () => {
  const bootstrapSrc = readFileSync(join(serverSrc, "bootstrap/index.ts"), "utf-8");

  it("imports McpConfigLoader from context/mcp-config", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader");
    expect(bootstrapSrc).toContain("../context/mcp-config");
  });

  it("calls McpConfigLoader.discover", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader.discover(");
  });

  it("calls McpConfigLoader.merge", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader.merge(");
  });
});
