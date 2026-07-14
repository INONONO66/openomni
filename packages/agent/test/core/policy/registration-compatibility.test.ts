import { describe, expect, it, mock } from "bun:test";
import type { CanonicalPolicyRegistrationGeneric } from "@openomni/policy";
import { PolicyDecision, type RuntimeResource } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";

function baseContext(): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

function promptContext(): Omit<PolicyContext, "timing"> & Record<string, unknown> {
  return {
    ...baseContext(),
    sessionId: "session",
    runId: "run",
    turnIndex: 0,
  };
}

const allow = () => PolicyDecision.allow({ policyId: "test.allow" });

describe("agent policy registration compatibility", () => {
  it("reads legacy registration accessors once at the trusted registration boundary", async () => {
    // Given
    const reads = { name: 0, timing: 0, priority: 0, fn: 0 };
    const middleware = mock(() => allow());
    const registration = {
      get name(): string {
        reads.name += 1;
        return "accessor-policy";
      },
      get timing(): "context.prepare" {
        reads.timing += 1;
        return "context.prepare";
      },
      get priority(): number {
        reads.priority += 1;
        return 0;
      },
      get fn(): typeof middleware {
        reads.fn += 1;
        return middleware;
      },
    };
    const engine = PolicyEngine.create();

    // When
    engine.register(registration);
    await engine.dispatchPoint("prompt.context.pre", promptContext());

    // Then
    expect(reads).toEqual({ name: 1, timing: 1, priority: 1, fn: 1 });
    expect(middleware).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy priority ordering through canonical point dispatch", async () => {
    // Given
    const legacyOrder: string[] = [];
    const canonicalOrder: string[] = [];
    const registrations = [
      { name: "infinite", priority: Number.POSITIVE_INFINITY },
      { name: "zero", priority: 0 },
      { name: "negative", priority: -10 },
      { name: "nan", priority: Number.NaN },
      { name: "negative-infinite", priority: Number.NEGATIVE_INFINITY },
    ] as const;
    const legacyEngine = PolicyEngine.create();
    const canonicalEngine = PolicyEngine.create();
    for (const registration of registrations) {
      legacyEngine.register({
        ...registration,
        timing: "context.prepare",
        fn: () => {
          legacyOrder.push(registration.name);
          return allow();
        },
      });
      canonicalEngine.register({
        ...registration,
        timing: "context.prepare",
        fn: () => {
          canonicalOrder.push(registration.name);
          return allow();
        },
      });
    }

    // When
    await legacyEngine.dispatch("context.prepare", baseContext());
    await canonicalEngine.dispatchPoint("prompt.context.pre", promptContext());

    // Then
    expect(canonicalOrder).toEqual(legacyOrder);
    expect(canonicalOrder).toContain("nan");
    expect(canonicalOrder.indexOf("negative")).toBeLessThan(canonicalOrder.indexOf("zero"));
    expect(canonicalOrder.indexOf("infinite")).toBeGreaterThan(canonicalOrder.indexOf("zero"));
  });

  it("preserves registration order across legacy and canonical stores at equal priority", async () => {
    // Given
    const called: string[] = [];
    const engine = PolicyEngine.create();
    engine.register({
      name: "legacy-first",
      timing: "context.prepare",
      priority: 0,
      fn: () => {
        called.push("legacy-first");
        return allow();
      },
    });
    engine.register({
      kind: "point",
      name: "canonical-second",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": [] },
      priority: 0,
      fn: () => {
        called.push("canonical-second");
        return allow();
      },
    });
    engine.register({
      name: "legacy-third",
      timing: "context.prepare",
      priority: 0,
      fn: () => {
        called.push("legacy-third");
        return allow();
      },
    });

    // When
    await engine.dispatchPoint("prompt.context.pre", promptContext());

    // Then
    expect(called).toEqual(["legacy-first", "canonical-second", "legacy-third"]);
  });

  it("does not reverse-map canonical invoke policies without an exact resource point", async () => {
    // Given
    const called: string[] = [];
    const pointIds = ["tool.native.pre", "tool.mcp.pre", "delegation.worker.pre"] as const;
    const engine = PolicyEngine.create();
    for (const pointId of pointIds) {
      engine.register({
        kind: "point",
        name: pointId,
        pointIds: [pointId],
        effectCapabilities: { [pointId]: [] },
        priority: 0,
        fn: () => {
          called.push(pointId);
          return allow();
        },
      } satisfies CanonicalPolicyRegistrationGeneric<PolicyContext>);
    }

    // When
    await engine.dispatch("invoke.prepare", baseContext());

    // Then
    expect(called).toEqual([]);
  });

  it("reverse-maps canonical invoke policies only for the exact resource point", async () => {
    // Given
    const called: string[] = [];
    const engine = PolicyEngine.create();
    const pointIds = ["tool.native.pre", "tool.mcp.pre", "delegation.worker.pre"] as const;
    for (const pointId of pointIds) {
      engine.register({
        kind: "point",
        name: pointId,
        pointIds: [pointId],
        effectCapabilities: { [pointId]: [] },
        priority: 0,
        fn: () => {
          called.push(pointId);
          return allow();
        },
      } satisfies CanonicalPolicyRegistrationGeneric<PolicyContext>);
    }
    const nativeTool: RuntimeResource.Descriptor = {
      id: "tool:shell",
      kind: "tool",
      labels: ["source.system"],
      capabilities: [],
      effects: [],
      source: { type: "system" },
    };
    const mcpTool: RuntimeResource.Descriptor = {
      id: "tool:mcp:filesystem:read_file",
      kind: "tool",
      labels: ["source.mcp"],
      capabilities: [],
      effects: [],
      source: { type: "mcp", serverId: "filesystem" },
    };
    const worker: RuntimeResource.Descriptor = {
      id: "worker:reviewer",
      kind: "worker",
      labels: [],
      capabilities: [],
      effects: [],
    };

    // When
    await engine.dispatch("invoke.prepare", { ...baseContext(), resourceDescriptor: nativeTool });
    await engine.dispatch("invoke.prepare", { ...baseContext(), resourceDescriptor: mcpTool });
    await engine.dispatch("invoke.prepare", { ...baseContext(), resourceDescriptor: worker });

    // Then
    expect(called).toEqual(pointIds);
  });

  it("uses the native point only for a descriptor-free legacy tool invocation", async () => {
    // Given
    const called: string[] = [];
    const engine = PolicyEngine.create();
    const pointIds = ["tool.native.pre", "tool.mcp.pre", "delegation.worker.pre"] as const;
    for (const pointId of pointIds) {
      engine.register({
        kind: "point",
        name: pointId,
        pointIds: [pointId],
        effectCapabilities: { [pointId]: [] },
        priority: 0,
        fn: () => {
          called.push(pointId);
          return allow();
        },
      } satisfies CanonicalPolicyRegistrationGeneric<PolicyContext>);
    }

    // When
    await engine.dispatch("invoke.prepare", { ...baseContext(), toolName: "shell" });

    // Then
    expect(called).toEqual(["tool.native.pre"]);
  });
});
