import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyContext } from "@openomni/agent";
import { PolicyEngine, type PolicyEngineInstanceGeneric } from "@openomni/policy";
import { Bus } from "@openomni/telemetry";
import { ContextAssembler, createContextMiddleware } from "../../src/context/middleware";

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

type ContextPolicyInput = Parameters<
  PolicyEngineInstanceGeneric<PolicyContext>["dispatchPoint"]
>[1];

function contextPolicyInput(): ContextPolicyInput {
  return {
    pointId: "prompt.context.pre",
    timing: "context.prepare",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    sessionId: "session-context",
    runId: "run-context",
    turnIndex: 0,
    // Pin: context assembly inherits the run's dispatch trace via
    // ctx.traceContext — a revert to discarding ctx (or a fallback mint)
    // would let the middleware run without this and go untraced.
    traceContext: { traceId: "trace-context-test", sessionId: "session-context" },
  };
}

async function dispatchContextMiddleware(
  middleware: ReturnType<typeof createContextMiddleware>,
  context: ContextPolicyInput,
) {
  const engine = PolicyEngine.create<PolicyContext>({ audit: false });
  engine.register(middleware);
  return engine.dispatchPoint("prompt.context.pre", context);
}

describe("createContextMiddleware", () => {
  it("has name 'server:context'", () => {
    const ws = makeWorkspace("test-name");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    expect(middleware.name).toBe("server:context");
  });

  it("declares only the prompt.context.pre point and append-context effect", () => {
    const ws = makeWorkspace("test-timing");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    expect(middleware.kind).toBe("point");
    expect(middleware.pointIds).toEqual(["prompt.context.pre"]);
    expect(middleware.effectCapabilities).toEqual({
      "prompt.context.pre": ["prompt.append_context"],
    });
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

  it("returns allow when workspace is empty", async () => {
    const ws = makeWorkspace("empty-workspace");
    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = contextPolicyInput();

    const result = await dispatchContextMiddleware(middleware, mockCtx);
    expect(result).toMatchObject({ verdict: "allow", effects: [] });
  });

  it("returns allow with append-context effect when AGENTS.md exists", async () => {
    const ws = makeWorkspace("with-agents");
    writeFileSync(join(ws, "AGENTS.md"), "# Project Knowledge\nSome rules here");

    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = contextPolicyInput();

    const result = await dispatchContextMiddleware(middleware, mockCtx);
    expect(result.verdict).toBe("allow");
    expect(result.effects).toEqual([
      expect.objectContaining({
        type: "prompt.append_context",
        context: expect.stringContaining("# Project Knowledge"),
      }),
    ]);
  });

  it("records a warn when ContextAssembler throws — fail-open, not fail-silent", async () => {
    // The loaders tolerate broken filesystem shapes, so the throw is driven
    // at the assembler seam directly.
    const ws = makeWorkspace("throwing-assembler");
    const middleware = createContextMiddleware({ workspaceRoot: ws });
    const assembleSpy = spyOn(ContextAssembler, "assemble").mockImplementation(() => {
      throw new Error("loader exploded");
    });
    const warns: Array<Record<string, unknown>> = [];
    const unsub = Bus.observe((event, data) => {
      if (event.name === "operational.warn") warns.push(data as Record<string, unknown>);
    });

    try {
      const result = await dispatchContextMiddleware(middleware, contextPolicyInput());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(result).toMatchObject({ verdict: "allow", effects: [] });
      // Pin (#606 audit): the swallow must leave a record under the run trace.
      const warn = warns.find(
        (entry) => entry.msg === "context assembly failed — run continues without it",
      );
      if (warn === undefined) throw new Error("no assembly warn recorded");
      expect(warn.traceId).toBe("trace-context-test");
      expect((warn.context as { error: string }).error).toBe("loader exploded");
    } finally {
      unsub();
      assembleSpy.mockRestore();
    }
  });

  it("appendContext contains AGENTS.md content when present", async () => {
    const ws = makeWorkspace("with-content");
    const agentsContent = "# Agent Configuration\nMaxTurns: 10";
    writeFileSync(join(ws, "AGENTS.md"), agentsContent);

    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = contextPolicyInput();

    const result = await dispatchContextMiddleware(middleware, mockCtx);
    expect(result.verdict).toBe("allow");
    expect(result.effects[0]).toMatchObject({ type: "prompt.append_context" });
    expect((result.effects[0] as { context?: string }).context).toContain("Agent Configuration");
    expect((result.effects[0] as { context?: string }).context).toContain("MaxTurns: 10");
  });

  it("refuses to assemble without the run trace context (no fallback mint)", async () => {
    // Pin (D11): a missing traceContext is a wiring bug — the middleware
    // throws (fail-open swallows it into a bare allow) instead of minting a
    // fallback trace, so AGENTS.md content is deliberately NOT appended.
    const ws = makeWorkspace("no-trace-context");
    writeFileSync(join(ws, "AGENTS.md"), "# Should not be appended");

    const middleware = createContextMiddleware({ workspaceRoot: ws });
    const mockCtx = { ...contextPolicyInput(), traceContext: undefined };

    // A bare allow is shape-identical to "middleware never selected", so the
    // pin also asserts the LOUD half: the engine records the middleware error
    // under its own trace (#656 review) — the drop is refuse-and-report, not
    // silence.
    const warns: Array<Record<string, unknown>> = [];
    const engine = PolicyEngine.create<PolicyContext>({
      traceContext: { traceId: "trace-engine", sessionId: "session-context", runId: "run-1" },
      auditEmit: (descriptor, data) => {
        if (descriptor.name === "operational.warn") warns.push(data as Record<string, unknown>);
      },
    });
    engine.register(middleware);
    const result = await engine.dispatchPoint("prompt.context.pre", {
      ...mockCtx,
      sessionId: "session-context",
      runId: "run-1",
      turnIndex: 0,
    });

    expect(result).toMatchObject({ verdict: "allow", effects: [] });
    const warn = warns.find((entry) => entry.msg === "middleware error");
    if (warn === undefined) throw new Error("no middleware error was recorded");
    // Attribution: the dispatch has no trace, so the record files under the
    // engine trace — and the refusal, not some other throw, is the cause.
    expect(warn.traceId).toBe("trace-engine");
    expect((warn.context as { error: string }).error).toContain("requires the run trace context");
  });

  it("returns allow when assembled context is empty string", async () => {
    const ws = makeWorkspace("empty-context");
    // Create workspace with no AGENTS.md and no skills
    const middleware = createContextMiddleware({ workspaceRoot: ws });

    const mockCtx = contextPolicyInput();

    const result = await dispatchContextMiddleware(middleware, mockCtx);
    expect(result).toMatchObject({ verdict: "allow", effects: [] });
  });
});
