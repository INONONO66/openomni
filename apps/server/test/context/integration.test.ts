import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverSrc = join(import.meta.dir, "../../src");

describe("context barrel export", () => {
  it("exports createContextMiddleware", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.createContextMiddleware).toBe("function");
  });

  it("exports ContextAssembler", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.ContextAssembler).toBe("object");
    expect(typeof mod.ContextAssembler.assemble).toBe("function");
  });

  it("exports McpConfigLoader", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.McpConfigLoader).toBe("object");
    expect(typeof mod.McpConfigLoader.discover).toBe("function");
    expect(typeof mod.McpConfigLoader.merge).toBe("function");
  });

  it("exports findUp", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.findUp).toBe("function");
  });

  it("exports _resetFindUpCache", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod._resetFindUpCache).toBe("function");
  });

  it("exports InstructionLoader", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.InstructionLoader).toBe("object");
  });

  it("exports SkillLoader", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.SkillLoader).toBe("object");
  });
});

describe("worker-entry wiring", () => {
  const workerRunnerSrc = readFileSync(join(serverSrc, "execution/worker-runner.ts"), "utf-8");

  it("worker runner imports createContextMiddleware from context/index", () => {
    expect(workerRunnerSrc).toContain("createContextMiddleware");
    expect(workerRunnerSrc).toContain("../context/index");
  });

  it("worker runner uses createContextMiddleware in middleware array", () => {
    expect(workerRunnerSrc).toContain("createContextMiddleware(");
    expect(workerRunnerSrc).toContain("...buildWorkerMiddleware(");
  });
});

describe("bootstrap/index.ts MCP config merging", () => {
  const bootstrapSrc = readFileSync(join(serverSrc, "bootstrap/index.ts"), "utf-8");

  it("imports McpConfigLoader", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader");
  });

  it("calls McpConfigLoader.discover", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader.discover(");
  });

  it("calls McpConfigLoader.merge", () => {
    expect(bootstrapSrc).toContain("McpConfigLoader.merge(");
  });
});
