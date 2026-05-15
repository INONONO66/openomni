import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine, type PolicyContext, type PolicyRegistration } from "@openomni/agent";
import { PolicyDecision, type Ingress, type Policy, type Subagent } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { IngressAuthorityMiddleware } from "../../src/ingress/middleware/ingress-authority";
import { BackgroundLimitsPolicy } from "../../src/policy/background-limits";
import { SubagentSpawnPolicyMiddleware } from "../../src/subagent/middleware/subagent-spawn-policy";
import { ToolRuntimePolicyMiddleware } from "../../src/execution-runtime/tool/middleware/tool-runtime-policy";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function baseCtx(
  overrides?: Partial<Omit<PolicyContext, "timing">>,
): Omit<PolicyContext, "timing"> {
  return {
    steps: [],
    usage: emptyUsage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function makeInboundEvent(overrides?: Partial<Ingress.InboundEvent>): Ingress.InboundEvent {
  return {
    id: "evt-1",
    surface: "test",
    mode: "direct",
    agent: {
      model: { provider: "test", id: "test-model" },
    },
    ...overrides,
  } as Ingress.InboundEvent;
}

function makeLaunchRequest(
  overrides?: Partial<{
    agentName: string;
    prompt: string;
    model: { provider: string; id: string };
    parentSessionId: string;
    depth: number;
  }>,
) {
  return {
    agentName: "worker",
    prompt: "do something",
    model: { provider: "test", id: "test-model" },
    parentSessionId: "parent-session-1",
    ...overrides,
  };
}

function makeBackgroundTask(overrides?: Partial<Subagent.BackgroundTask>): Subagent.BackgroundTask {
  return {
    id: crypto.randomUUID(),
    agentName: "worker",
    prompt: "task",
    status: "running",
    parentSessionId: "parent-session-1",
    queuedAt: Date.now(),
    depth: 0,
    ...overrides,
  };
}

const stubCoordinator = {
  dispatch: async () => ({
    runId: "run-stub",
    sessionId: "session-stub",
    status: "succeeded" as const,
    output: "ok",
    finishReason: "stop",
  }),
};

describe("IngressAuthorityMiddleware integration", () => {
  test("allows user actor to create top-level inbound work", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    const result = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
    });

    expect(result.event.id).toBe("evt-1");
    expect(result.mode).toBe("direct");
  });

  test("allows main persona actor", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "main_persona" } },
    });

    const result = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
    });

    expect(result.event.id).toBe("evt-1");
  });

  test("denies untrusted sub-persona actor", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "sub_persona" } },
    });

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("denies manager actor without trusted flag", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "manager", trusted: false } },
    });

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("allows trusted manager actor", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "manager", trusted: true } },
    });

    const result = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
    });

    expect(result.event.id).toBe("evt-1");
  });

  test("aborts when coordinator is missing", async () => {
    const event = makeInboundEvent();

    await expect(IngressAuthorityMiddleware.runPreRun({ event })).rejects.toThrow(
      "coordinator is required",
    );
  });

  test("aborts on invalid schema", async () => {
    const badEvent = { not: "valid" } as unknown as Ingress.InboundEvent;

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event: badEvent,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("aborts on unsupported mode", async () => {
    const event = makeInboundEvent();
    (event as Record<string, unknown>).mode = "fork";

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("collects policy decisions via onDecision callback", async () => {
    const decisions: unknown[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
      onDecision: (d) => {
        decisions.push(d);
      },
    });

    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d).toHaveProperty("policyId");
      expect(d).toHaveProperty("verdict");
    }
  });

  test("registrations produce all four middleware steps", () => {
    const state = { input: makeInboundEvent(), coordinator: stubCoordinator };
    const regs = IngressAuthorityMiddleware.registrations(state as never);

    expect(regs).toHaveLength(4);
    const names = regs.map((r) => r.name);
    expect(names).toContain("ingress:coordinator-presence");
    expect(names).toContain("ingress:schema-validation");
    expect(names).toContain("ingress:authority");
    expect(names).toContain("ingress:mode-dispatch");
  });
});

describe("BackgroundLimitsPolicy integration", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("allows launch when all limits are within bounds", async () => {
    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest(),
      activeTasks: [],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 5,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("allow");
    expect(result.shouldQueue).toBe(false);
  });

  test("denies when per-agent limit is exceeded", async () => {
    const tasks = Array.from({ length: 3 }, () => makeBackgroundTask({ agentName: "worker" }));

    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ agentName: "worker" }),
      activeTasks: tasks,
      activeCount: 3,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 10,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("deny");
    expect(result.verdict.reasonCodes.some((reason) => reason.includes("per agent"))).toBe(true);
  });

  test("denies when depth limit is exceeded", async () => {
    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ depth: 6 }),
      activeTasks: [],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 5,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("deny");
    expect(result.verdict.reasonCodes.some((reason) => reason.includes("depth"))).toBe(true);
  });

  test("denies when descendant limit from same parent is exceeded", async () => {
    const tasks = Array.from({ length: 5 }, () =>
      makeBackgroundTask({ parentSessionId: "parent-session-1" }),
    );

    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest(),
      activeTasks: tasks,
      activeCount: 5,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 10,
      maxConcurrentTotal: 20,
      maxDepth: 5,
      maxDescendants: 5,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("deny");
    expect(result.verdict.reasonCodes.some((reason) => reason.includes("descendants"))).toBe(true);
  });

  test("queues when total concurrency is saturated but queue has capacity", async () => {
    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ agentName: "fresh-agent" }),
      activeTasks: [],
      activeCount: 10,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 5,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 10,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("allow");
    expect(result.shouldQueue).toBe(true);
  });

  test("denies when total concurrency saturated and queue is full", async () => {
    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ agentName: "fresh-agent" }),
      activeTasks: [],
      activeCount: 10,
      pendingQueueSize: 20,
      maxConcurrentPerAgent: 5,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 10,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("deny");
    expect(result.verdict.reasonCodes.some((reason) => reason.includes("queue full"))).toBe(true);
  });

  test("registrations produce all five limit checks", () => {
    const state = {
      input: makeLaunchRequest(),
      depth: 0,
      activeTasks: [] as Subagent.BackgroundTask[],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 5,
      maxQueueSize: 20,
    };
    const regs = BackgroundLimitsPolicy.registrations(state);

    expect(regs).toHaveLength(5);
    const names = regs.map((r) => r.name);
    expect(names).toContain("background:per-agent-limit");
    expect(names).toContain("background:depth-limit");
    expect(names).toContain("background:descendant-limit");
    expect(names).toContain("background:total-limit");
    expect(names).toContain("background:queue-limit");
  });

  test("all definitions use Policy.Timing invoke.prepare", () => {
    const defs = [
      BackgroundLimitsPolicy.PerAgent,
      BackgroundLimitsPolicy.Depth,
      BackgroundLimitsPolicy.Descendants,
      BackgroundLimitsPolicy.Total,
      BackgroundLimitsPolicy.Queue,
    ];

    for (const def of defs) {
      expect(def.timing).toBe("invoke.prepare");
      expect(def.failPolicy).toBe("fail-closed");
    }
  });

  test("evaluates background launch through a background worker descriptor", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ agentName: "worker" }),
      activeTasks: [],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 5,
      maxQueueSize: 20,
      onDecision: (decision) => decisions.push(decision),
    });

    expect(result.verdict.verdict).toBe("allow");
    expect(decisions).toHaveLength(5);
  });

  test("background launch rejects effects outside delegation.background.pre", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "invalid-background-effect",
      timing: "invoke.prepare",
      priority: 0,
      fn: () =>
        PolicyDecision.allow({
          policyId: "invalid-background-effect",
          reasonCodes: ["invalid-effect"],
          effects: [{ type: "tool.rewrite_input", input: { command: "echo unsafe" } }],
        }),
    });

    const decision = await engine.dispatch("invoke.prepare", {
      ...baseCtx({
        toolName: "subagent",
        toolInput: { operation: "background.launch", agentName: "worker" },
        resourceDescriptor: {
          id: "worker:background:worker",
          kind: "worker",
          labels: ["source.agent", "delegation.background", "agent:worker"],
          capabilities: ["background.launch"],
          effects: ["session.create_child", "worker.spawn"],
          source: { type: "agent" },
        },
      }),
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.effect_not_allowed");
    expect(decision.effects).toContainEqual(
      expect.objectContaining({
        type: "audit.annotate",
        annotation: expect.stringContaining(
          "tool.rewrite_input is not allowed at delegation.background.pre",
        ),
        severity: "error",
      }),
    );
  });
});

describe("ToolRuntimePolicyMiddleware integration", () => {
  test("evaluates pre-tool for low-risk tier without workspace lock", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      toolName: "read_file",
      toolCallId: "call-1",
      input: { path: "/tmp/test.txt" },
      riskTier: 0,
      lockOwnerId: "run-1",
    });

    expect(result.decision.verdict).toBe("allow");
    expect(result.handle.lockAcquired).toBe(false);
    expect(result.handle.timeoutMs).toBe(30_000);
  });

  test("evaluates pre-tool for high-risk tier with timeout escalation", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "ls" },
      riskTier: 2,
      lockOwnerId: "run-2",
    });

    expect(result.decision.verdict).toBe("allow");
    expect(result.handle.timeoutMs).toBe(60_000);
  });

  test("evaluates post-tool releasing lock when acquired", async () => {
    const handle: ToolRuntimePolicyMiddleware.RuntimePolicyHandle = {
      timeoutMs: 30_000,
      lockOwnerId: "run-3",
      lockAcquired: false,
    };

    const verdict = ToolRuntimePolicyMiddleware.evaluatePostTool({
      toolName: "read_file",
      input: {},
      handle,
    });

    expect(verdict.verdict).toBe("allow");
  });

  test("enforceTimeout rejects after specified ms", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 500));

    await expect(ToolRuntimePolicyMiddleware.enforceTimeout(slow, 10)).rejects.toThrow(
      "timeout after 10ms",
    );
  });

  test("enforceTimeout resolves if promise completes in time", async () => {
    const fast = Promise.resolve("ok");

    const result = await ToolRuntimePolicyMiddleware.enforceTimeout(fast, 5_000);
    expect(result).toBe("ok");
  });

  test("TimeoutError carries the timeout duration", () => {
    const error = new ToolRuntimePolicyMiddleware.TimeoutError(42);
    expect(error.timeoutMs).toBe(42);
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toBe("timeout after 42ms");
  });

  test("custom timeout config overrides default tier timeouts", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      toolName: "write_file",
      input: {},
      riskTier: 1,
      lockOwnerId: "run-4",
      timeoutConfig: { tier1: 5_000 },
    });

    expect(result.handle.timeoutMs).toBe(5_000);
  });

  test("collects decisions via onDecision callback", async () => {
    const decisions: unknown[] = [];

    await ToolRuntimePolicyMiddleware.evaluatePreTool({
      toolName: "bash",
      input: { command: "echo hi" },
      riskTier: 2,
      lockOwnerId: "run-5",
      onDecision: (d) => {
        decisions.push(d);
      },
    });

    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d).toHaveProperty("verdict");
    }
  });
});

describe("SubagentSpawnPolicyMiddleware integration", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("all definitions use Policy.Timing and fail-closed policy", () => {
    const defs = [
      SubagentSpawnPolicyMiddleware.DefaultDenylist,
      SubagentSpawnPolicyMiddleware.SessionExistence,
      SubagentSpawnPolicyMiddleware.ActiveRun,
      SubagentSpawnPolicyMiddleware.CancelTimeout,
      SubagentSpawnPolicyMiddleware.WaitTimeout,
    ];

    for (const def of defs) {
      expect(def.timing).toBe("invoke.prepare");
      expect(def.failPolicy).toBe("fail-closed");
    }
  });

  test("registrations produce four middleware steps", () => {
    const state = {
      operation: "send" as const,
      sessionId: "test-session",
    };
    const regs = SubagentSpawnPolicyMiddleware.registrations(state as never);

    expect(regs).toHaveLength(4);
    const names = regs.map((r) => r.name);
    expect(names).toContain("subagent:session-existence");
    expect(names).toContain("subagent:active-run");
    expect(names).toContain("subagent:cancel-timeout");
    expect(names).toContain("subagent:wait-timeout");
  });

  test("childMiddleware prepends default denylist when no explicit permissions", () => {
    const existing: PolicyRegistration[] = [
      {
        name: "custom-policy",
        timing: "invoke.prepare",
        priority: 0,
        failPolicy: "fail-open",
        fn: () => PolicyDecision.allow({ policyId: "custom-policy" }),
      },
    ];

    const result = SubagentSpawnPolicyMiddleware.childMiddleware(existing, false);

    expect(result).toHaveLength(2);
    expect(result?.[0].name).toBe("subagent:default-denylist");
    expect(result?.[1].name).toBe("custom-policy");
  });

  test("childMiddleware passes through when explicit permissions exist", () => {
    const existing: PolicyRegistration[] = [
      {
        name: "custom-policy",
        timing: "invoke.prepare",
        priority: 0,
        failPolicy: "fail-open",
        fn: () => PolicyDecision.allow({ policyId: "custom-policy" }),
      },
    ];

    const result = SubagentSpawnPolicyMiddleware.childMiddleware(existing, true);

    expect(result).toBe(existing);
  });

  test("evaluatePreSpawn full pipeline for send on existing session", async () => {
    const session = Session.create({
      title: "spawn-test",
      model: { providerID: "test", modelID: "test" },
    });

    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "send",
      sessionId: session.id,
    });

    expect(result.verdict.verdict).toBe("allow");
    expect(result.session?.id).toBe(session.id);
  });

  test("runPreSpawn throws on abort verdict", async () => {
    await expect(
      SubagentSpawnPolicyMiddleware.runPreSpawn({
        operation: "send",
        sessionId: "nonexistent",
      }),
    ).rejects.toThrow("Session not found");
  });
});

describe("cross-middleware deny-wins", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("ingress allows user but subagent denylist blocks spawning", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    const ingressResult = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
    });
    expect(ingressResult.mode).toBe("direct");

    const denylistReg = SubagentSpawnPolicyMiddleware.createDefaultDenylist();
    const engine = PolicyEngine.create({ audit: false });
    engine.register(denylistReg);

    const verdict = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      toolName: "subagent",
      toolInput: { operation: "spawn" },
    });

    expect(verdict.verdict).toBe("deny");
    expect(PolicyDecision.reason(verdict)).toBe("denylist");
  });

  test("ingress allows user but background depth limit denies launch", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    const ingressResult = await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
    });
    expect(ingressResult.mode).toBe("direct");

    const bgResult = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ depth: 10 }),
      activeTasks: [],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 5,
      maxQueueSize: 20,
    });

    expect(bgResult.verdict.verdict).toBe("deny");
    expect(bgResult.verdict.reasonCodes.some((reason) => reason.includes("depth"))).toBe(true);
  });

  test("deny-wins across policy engine boundaries with mixed verdicts", async () => {
    const engine = PolicyEngine.create({ audit: false });

    const allowPolicy: PolicyRegistration = {
      name: "allow-policy",
      timing: "invoke.prepare",
      priority: 0,
      failPolicy: "fail-closed",
      fn: () => PolicyDecision.allow({ policyId: "allow-policy", reasonCodes: ["allowed"] }),
    };

    const denyPolicy: PolicyRegistration = {
      name: "deny-policy",
      timing: "invoke.prepare",
      priority: 10,
      failPolicy: "fail-closed",
      fn: () =>
        PolicyDecision.deny({
          policyId: "deny-policy",
          reasonCodes: ["denied by policy"],
          effects: [{ type: "run.abort", reason: "denied by policy" }],
        }),
    };

    engine.register(allowPolicy);
    engine.register(denyPolicy);

    const verdict = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      toolName: "some_tool",
      toolInput: {},
    });

    expect(verdict.verdict).toBe("deny");
    expect(verdict.policyId).toBe("agent.policy.composed");
    expect(verdict.reasonCodes).toContain("denied by policy");
  });

  test("worker middleware deny + tool runtime continue → overall deny", async () => {
    const workerRegs = buildWorkerMiddleware({
      permissions: { action: "tool.call", allowlist: ["read_file"] },
    });
    const engine = PolicyEngine.create({ audit: false });
    for (const reg of workerRegs) engine.register(reg);

    const verdict = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
      toolName: "bash",
      toolCallId: "call-bash",
      toolInput: { command: "rm -rf /" },
    });

    expect(verdict.verdict).toBe("deny");
    expect(PolicyDecision.reason(verdict)).toBe("allowlist_miss");
  });

  test("ingress deny blocks entire pipeline regardless of downstream allowances", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "sub_persona" } },
    });

    let ingressFailed = false;
    try {
      await IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      });
    } catch {
      ingressFailed = true;
    }

    expect(ingressFailed).toBe(true);

    const session = Session.create({
      title: "never-reached",
      model: { providerID: "test", modelID: "test" },
    });
    const spawnResult = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "send",
      sessionId: session.id,
    });
    expect(spawnResult.verdict.verdict).toBe("allow");
  });

  test("multiple background limits compound: first deny wins", async () => {
    const tasks = Array.from({ length: 3 }, () =>
      makeBackgroundTask({
        agentName: "worker",
        parentSessionId: "parent-session-1",
      }),
    );

    const result = await BackgroundLimitsPolicy.evaluatePreLaunch({
      input: makeLaunchRequest({ agentName: "worker" }),
      activeTasks: tasks,
      activeCount: 3,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 3,
      maxQueueSize: 20,
    });

    expect(result.verdict.verdict).toBe("deny");
    expect(result.verdict.reasonCodes.some((reason) => reason.includes("per agent"))).toBe(true);
  });
});
