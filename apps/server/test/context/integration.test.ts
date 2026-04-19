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

  it("exports InstructionLoader", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.InstructionLoader).toBe("object");
  });

  it("exports SkillLoader", async () => {
    const mod = await import("../../src/context/index");
    expect(typeof mod.SkillLoader).toBe("object");
  });
});

describe("local-runner wiring", () => {
  const localRunnerSrc = readFileSync(join(serverSrc, "bootstrap/local-runner.ts"), "utf-8");

  it("imports createContextMiddleware from context/index", () => {
    expect(localRunnerSrc).toContain("createContextMiddleware");
    expect(localRunnerSrc).toContain("../context/index");
  });

  it("imports ContextAssembler from context/index", () => {
    expect(localRunnerSrc).toContain("ContextAssembler");
  });

  it("uses createContextMiddleware in runDirect middleware array", () => {
    expect(localRunnerSrc).toContain("createContextMiddleware(");
    expect(localRunnerSrc).toContain("...buildWorkerMiddleware(");
  });

  it("assembles plan context in executePlan", () => {
    expect(localRunnerSrc).toContain("ContextAssembler.assemble(");
    expect(localRunnerSrc).toContain("planSystemPrompt");
  });
});

describe("worker-entry wiring", () => {
  const workerEntrySrc = readFileSync(join(serverSrc, "execution/worker-entry.ts"), "utf-8");

  it("imports createContextMiddleware from context/index", () => {
    expect(workerEntrySrc).toContain("createContextMiddleware");
    expect(workerEntrySrc).toContain("../context/index");
  });

  it("imports ContextAssembler from context/index", () => {
    expect(workerEntrySrc).toContain("ContextAssembler");
  });

  it("uses createContextMiddleware in direct mode middleware array", () => {
    expect(workerEntrySrc).toContain("createContextMiddleware(");
    expect(workerEntrySrc).toContain("...buildWorkerMiddleware(");
  });

  it("assembles plan context in plan mode", () => {
    expect(workerEntrySrc).toContain("ContextAssembler.assemble(");
    expect(workerEntrySrc).toContain("planSystemPrompt");
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
