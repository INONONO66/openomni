import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyContext } from "@openomni/agent";
import { createContextMiddleware } from "../../src/context/middleware";

let tempRoot: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "context-middleware-test-")));
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeWorkspace(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("createContextMiddleware", () => {
  it("has name 'server:context'", () => {
    const ws = makeWorkspace("test-name");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    expect(middleware.name).toBe("server:context");
  });

  it("has timing 'context.prepare'", () => {
    const ws = makeWorkspace("test-timing");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    expect(middleware.timing).toBe("context.prepare");
  });

  it("has priority 50", () => {
    const ws = makeWorkspace("test-priority");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    expect(middleware.priority).toBe(50);
  });

  it("has failPolicy 'fail-open'", () => {
    const ws = makeWorkspace("test-failpolicy");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    expect(middleware.failPolicy).toBe("fail-open");
  });

  it("returns { action: 'continue' } when workspace is empty", async () => {
    const ws = makeWorkspace("empty-workspace");
    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = {
      messages: [],
      systemPrompt: "base prompt",
      agentType: undefined,
      timing: "context.prepare" as const,
    } as unknown as PolicyContext;

    const result = await middleware.fn(mockCtx);
    expect(result).toEqual({ action: "continue" });
  });

  it("returns { action: 'transform', input: { appendContext: '...' } } when AGENTS.md exists", async () => {
    const ws = makeWorkspace("with-agents");
    writeFileSync(join(ws, "AGENTS.md"), "# Project Knowledge\nSome rules here");

    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = {
      messages: [],
      systemPrompt: "base prompt",
      agentType: undefined,
      timing: "context.prepare" as const,
    } as unknown as PolicyContext;

    const result = await middleware.fn(mockCtx);
    expect(result.action).toBe("transform");
    if (result.action === "transform") {
      expect(result.input).toBeDefined();
      const appendContext = result.input.appendContext as string | undefined;
      expect(appendContext).toBeDefined();
      expect(appendContext).toContain("# Project Knowledge");
    }
  });

  it("returns { action: 'continue' } when ContextAssembler throws", async () => {
    // Create a workspace that will cause assembler to fail (e.g., permission issue)
    // For this test, we'll just use a non-existent path
    const middleware = createContextMiddleware({ workspaceRoot: "/nonexistent/path/xyz" });

    const mockCtx = {
      messages: [],
      systemPrompt: "base prompt",
      agentType: undefined,
      timing: "context.prepare" as const,
    } as unknown as PolicyContext;

    const result = await middleware.fn(mockCtx);
    expect(result).toEqual({ action: "continue" });
  });

  it("appendContext contains AGENTS.md content when present", async () => {
    const ws = makeWorkspace("with-content");
    const agentsContent = "# Agent Configuration\nMaxTurns: 10";
    writeFileSync(join(ws, "AGENTS.md"), agentsContent);

    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = {
      messages: [],
      systemPrompt: "base prompt",
      agentType: undefined,
      timing: "context.prepare" as const,
    } as unknown as PolicyContext;

    const result = await middleware.fn(mockCtx);
    expect(result.action).toBe("transform");
    if (result.action === "transform") {
      const appendContext = result.input.appendContext as string | undefined;
      expect(appendContext).toContain("Agent Configuration");
      expect(appendContext).toContain("MaxTurns: 10");
    }
  });

  it("returns { action: 'continue' } when assembled context is empty string", async () => {
    const ws = makeWorkspace("empty-context");
    // Create workspace with no AGENTS.md and no skills
    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = {
      messages: [],
      systemPrompt: "base prompt",
      agentType: undefined,
      timing: "context.prepare" as const,
    } as unknown as PolicyContext;

    const result = await middleware.fn(mockCtx);
    expect(result).toEqual({ action: "continue" });
  });
});
