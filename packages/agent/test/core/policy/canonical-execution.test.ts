import { describe, expect, it, mock } from "bun:test";
import type { CanonicalAuditDispatchContextGeneric } from "@openomni/policy/src/engine/types";
import type { CanonicalPolicyRegistrationGeneric } from "@openomni/policy/src/engine/types";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus } from "../../../src/index";
import { createToolExecutor } from "../../../src/core/execution/tools";
import { buildPolicyEngine } from "../../../src/core/execution/run";
import { runAgent } from "../../../src/core/execution/run";
import { createCompactionPolicy } from "../../../src/compaction";
import type { PolicyContext } from "../../../src/core/policy/types";
import type { ChatAgentConfig } from "../../../src/core/types";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";
import { captureBusEvents } from "../../helpers/bus-event";

const allow = () => PolicyDecision.allow({ policyId: "test.allow" });

describe("canonical ChatAgent policy execution", () => {
  it("stamps the derived legacy timing alias on canonical dispatch contexts", async () => {
    // Given (#530: legacy timing registrations are rejected at register(); the
    // former legacy middleware is now registered canonically at the mapped
    // point, and dispatch still derives the timing alias from the point.)
    const legacy = mock((_ctx: unknown) => allow());
    const engine = buildPolicyEngine(
      {
        events: Bus,
        model: { provider: "test", id: "model" },
        middleware: [
          {
            kind: "point",
            name: "legacy",
            pointIds: ["prompt.context.pre"],
            effectCapabilities: { "prompt.context.pre": [] },
            priority: 1,
            fn: legacy,
          },
        ],
      },
      { traceId: "trace", sessionId: "session", runId: "run", actorId: "actor" },
    );

    // When
    await engine.dispatchPoint("prompt.context.pre", {
      sessionId: "session",
      runId: "run",
      turnIndex: 0,
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
    });

    // Then
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(legacy.mock.calls[0]?.[0]).toMatchObject({
      timing: "context.prepare",
      pointId: "prompt.context.pre",
    });
  });

  it("dispatches exact canonical points with one stable fallback identity", async () => {
    // Given
    const seen: Array<{
      readonly pointId: string;
      readonly sessionId: unknown;
      readonly runId: unknown;
      readonly turnIndex: unknown;
      readonly modelId: unknown;
    }> = [];
    const pointIds = [
      "run.lifecycle.pre",
      "run.turn.pre",
      "prompt.context.pre",
      "tool.catalog.pre",
      "connection.llm.pre",
      "connection.llm.post",
      "run.turn.post",
      "run.lifecycle.post",
    ] as const;
    const middleware = {
      kind: "point",
      name: "canonical-observer",
      pointIds,
      effectCapabilities: {
        "run.lifecycle.pre": [],
        "run.turn.pre": [],
        "prompt.context.pre": [],
        "tool.catalog.pre": [],
        "connection.llm.pre": [],
        "connection.llm.post": [],
        "run.turn.post": [],
        "run.lifecycle.post": [],
      },
      priority: 1,
      fn: (ctx) => {
        seen.push({
          pointId: ctx.pointId,
          sessionId: Reflect.get(ctx, "sessionId"),
          runId: Reflect.get(ctx, "runId"),
          turnIndex: Reflect.get(ctx, "turnIndex"),
          modelId: Reflect.get(ctx, "modelId"),
        });
        return allow();
      },
    } satisfies CanonicalPolicyRegistrationGeneric<PolicyContext>;
    const config: ChatAgentConfig = {
      events: Bus,
      model: { provider: "test", id: "model-1" },
      middleware: [middleware],
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => createStopOutcome(),
      }),
    };

    // When
    const result = await runAgent(runInput([{ role: "user", content: "hi" }]), config);

    // Then
    expect(result.finishReason).toBe("stop");
    expect(seen.map((entry) => entry.pointId)).toEqual([...pointIds]);
    expect(new Set(seen.map((entry) => entry.sessionId)).size).toBe(1);
    expect(new Set(seen.map((entry) => entry.runId)).size).toBe(1);
    expect(typeof seen[0]?.sessionId).toBe("string");
    expect(typeof seen[0]?.runId).toBe("string");
    expect(seen.find((entry) => entry.pointId === "run.turn.pre")?.turnIndex).toBe(0);
    // #752 F4: the connection points carry the RESOLVED model the call
    // actually runs (the mock resolver's id), not the configured ref — after
    // a fallback switch the two diverge and the resolved one is the truth.
    expect(seen.find((entry) => entry.pointId === "connection.llm.pre")?.modelId).toBe(
      mockProviderModel.id,
    );
  });
});

describe("canonical tool policy execution", () => {
  it("keeps generated identities and observer errors compatible", async () => {
    // Given
    const policyIdentities: Array<{
      readonly sessionId: unknown;
      readonly runId: unknown;
    }> = [];
    const delegatedContexts: Array<{ sessionId?: string; runId?: string } | undefined> = [];
    const observerFailure = { toString: () => "observer-failure" };
    const warnings = captureBusEvents(Operational.Events.Warn, 2);
    const engine = buildPolicyEngine(
      {
        events: Bus,
        model: { provider: "test", id: "model" },
        middleware: [
          {
            kind: "point",
            name: "identity-observer",
            pointIds: ["tool.native.pre"],
            effectCapabilities: { "tool.native.pre": [] },
            priority: 1,
            fn: (ctx: Readonly<CanonicalAuditDispatchContextGeneric<PolicyContext>>) => {
              policyIdentities.push({
                sessionId: Reflect.get(ctx, "sessionId"),
                runId: Reflect.get(ctx, "runId"),
              });
              return allow();
            },
          },
        ],
      },
      { traceId: "trace", sessionId: "session", runId: "run", actorId: "actor" },
    );
    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      engine,
      onDecision: () => {
        throw observerFailure;
      },
      toolExecutor: async (call, context) => {
        delegatedContexts.push(context?.traceContext);
        return { id: "result", toolCallId: call.id, output: "ok" };
      },
    });

    try {
      // When
      await executor({ id: "call", tool: "read_file", input: {} });
      const warningErrors = (await warnings.done).map((event) => event.context?.error);

      // Then
      expect(warnings.events).toHaveLength(2);
      expect(policyIdentities).toHaveLength(1);
      expect(typeof policyIdentities[0]?.sessionId).toBe("string");
      expect(typeof policyIdentities[0]?.runId).toBe("string");
      expect(delegatedContexts).toHaveLength(1);
      expect(typeof delegatedContexts[0]?.sessionId).toBe("string");
      expect(typeof delegatedContexts[0]?.runId).toBe("string");
      expect(warningErrors).toEqual(["observer-failure", "observer-failure"]);
    } finally {
      warnings.unsubscribe();
    }
  });

  it("dispatches MCP pre and post with the server id and real tool values", async () => {
    // Given
    const seen: Array<{ readonly pointId: string; readonly serverId: unknown }> = [];
    const engine = buildPolicyEngine(
      {
        events: Bus,
        model: { provider: "test", id: "model" },
        middleware: [
          {
            kind: "point",
            name: "mcp-observer",
            pointIds: ["tool.mcp.pre", "tool.mcp.post"],
            effectCapabilities: { "tool.mcp.pre": [], "tool.mcp.post": [] },
            priority: 1,
            fn: (ctx: Readonly<CanonicalAuditDispatchContextGeneric<PolicyContext>>) => {
              seen.push({ pointId: ctx.pointId, serverId: Reflect.get(ctx, "mcpServerId") });
              return allow();
            },
          },
        ],
      },
      { traceId: "trace", sessionId: "session", runId: "run", actorId: "actor" },
    );
    const executor = createToolExecutor({
      events: Bus,
      engine,
      traceContext: { traceId: "trace", sessionId: "session", runId: "run" },
      getToolLabels: () => ["source:mcp", "mcp.filesystem"],
      toolExecutor: async (call) => ({ id: "result", toolCallId: call.id, output: "ok" }),
    });

    // When
    await executor({ id: "call", tool: "read_file", input: { path: "/tmp/a" } });

    // Then
    expect(seen).toEqual([
      { pointId: "tool.mcp.pre", serverId: "filesystem" },
      { pointId: "tool.mcp.post", serverId: "filesystem" },
    ]);
  });

  it("fails closed when an MCP tool omits its required server id", async () => {
    // Given
    const toolExecutor = mock(async (call: { readonly id: string }) => ({
      id: "result",
      toolCallId: call.id,
      output: "ok",
    }));
    const engine = buildPolicyEngine(
      { events: Bus, model: { provider: "test", id: "model" } },
      { traceId: "trace", sessionId: "session", runId: "run", actorId: "actor" },
    );
    const executor = createToolExecutor({
      events: Bus,
      engine,
      traceContext: { traceId: "trace", sessionId: "session", runId: "run" },
      getToolLabels: () => ["source:mcp"],
      toolExecutor,
    });

    // When
    const result = await executor({ id: "call", tool: "read_file", input: {} });

    // Then
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("policy.context_missing");
    expect(toolExecutor).not.toHaveBeenCalled();
  });
});

describe("canonical builtin registrations", () => {
  it("declare their policy points and effect capabilities", () => {
    // Given / When — factory form since L4 (per-run speculator state); the
    // created registration carries the canonical shape.
    const registrations = [
      createCompactionPolicy({ priority: 900, events: Bus, contextWindowTokens: 100 }).create(),
    ];

    // Then — without a summarizer there is no speculation, so no turn.post.
    expect(registrations[0]?.pointIds).toEqual(["run.completion.pre"]);
  });
});
