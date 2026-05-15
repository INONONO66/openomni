import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PolicyEngine, type PolicyContext } from "@openomni/agent";
import { PolicyDecision, type RuntimeResource } from "@openomni/protocol";
import { Session, Storage, WorkerRun } from "@openomni/session";
import { SubagentSpawnPolicyMiddleware } from "../../src/subagent";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const noop = () => undefined;

function middlewareContext(toolName: string): PolicyContext {
  return {
    timing: "invoke.prepare",
    steps: [],
    usage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName,
    toolInput: {},
  };
}

function createSession(): ReturnType<typeof Session.create> {
  return Session.create({
    title: "policy-test",
    model: { providerID: "test", modelID: "test" },
  });
}

describe("SubagentSpawnPolicyMiddleware", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  test("default denylist aborts subagent tool calls with policy metadata", async () => {
    const registration = SubagentSpawnPolicyMiddleware.createDefaultDenylist();

    const verdict = await registration.fn(middlewareContext("subagent"));

    expect(verdict).toMatchObject({
      verdict: "deny",
      policyId: "guardrail.permission",
    });
    expect(PolicyDecision.reason(verdict)).toBe("denylist");
  });

  test("default denylist ignores non-subagent tool calls", async () => {
    const registration = SubagentSpawnPolicyMiddleware.createDefaultDenylist();

    const verdict = await registration.fn(middlewareContext("read_file"));

    expect(verdict.verdict).toBe("allow");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  test("session existence policy preserves legacy send error text", async () => {
    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "send",
      sessionId: "missing-session",
    });

    expect(result.verdict).toMatchObject({
      verdict: "deny",
      policyId: "agent.policy.composed",
    });
    expect(PolicyDecision.reason(result.verdict)).toBe("Session not found: missing-session");
  });

  test("session existence policy returns session for valid calls", async () => {
    const session = createSession();

    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "send",
      sessionId: session.id,
    });

    expect(result.verdict.verdict).toBe("allow");
    expect(result.session?.id).toBe(session.id);
  });

  test("active-run policy preserves legacy resume error text", async () => {
    const session = createSession();
    const runId = crypto.randomUUID();
    await WorkerRun.create(session.id, { runId, title: "active", prompt: "working" });
    await WorkerRun.updateStatus(session.id, runId, "starting");
    await WorkerRun.updateStatus(session.id, runId, "running");

    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "resume",
      sessionId: session.id,
    });

    expect(result.verdict).toMatchObject({
      verdict: "deny",
      policyId: "agent.policy.composed",
    });
    expect(result.verdict.reasonCodes).toContain("Session already has an active run");
  });

  test("cancel timeout policy resolves default and explicit hard timeout", async () => {
    const session = createSession();

    const defaulted = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "cancel",
      sessionId: session.id,
    });
    const explicit = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "cancel",
      sessionId: session.id,
      hardTimeoutMs: 25,
    });

    expect(defaulted.cancelHardTimeoutMs).toBe(10_000);
    expect(explicit.cancelHardTimeoutMs).toBe(25);
  });

  test("wait timeout policy carries timeout into enforcement helper", async () => {
    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "wait",
      sessionId: "session-id",
      timeoutMs: 80,
    });

    expect(result.verdict.verdict).toBe("allow");
    expect(result.waitTimeoutMs).toBe(80);
    expect(SubagentSpawnPolicyMiddleware.enforceWaitTimeout(undefined, noop)).toBeUndefined();
  });
  test("evaluatePreSpawn dispatches send with a subagent worker descriptor", async () => {
    const session = createSession();
    const captured: Array<PolicyContext & { resourceDescriptor?: RuntimeResource.Descriptor }> = [];
    const createPolicyEngine = PolicyEngine.create;
    const policyEngineSpy = spyOn(PolicyEngine, "create").mockImplementation((options) => {
      const engine = createPolicyEngine(options);
      const dispatch = engine.dispatch;
      engine.dispatch = async (timing, ctx) => {
        captured.push(ctx as PolicyContext & { resourceDescriptor?: RuntimeResource.Descriptor });
        return dispatch(timing, ctx);
      };
      return engine;
    });

    try {
      await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
        operation: "send",
        sessionId: session.id,
      });
    } finally {
      policyEngineSpy.mockRestore();
    }

    expect(captured[0]?.resourceDescriptor).toEqual({
      id: "worker:subagent:send",
      kind: "worker",
      source: { type: "agent" },
      labels: ["source.agent", "delegation.subagent", "operation.send"],
      capabilities: ["delegation.send"],
      effects: ["session.message"],
    });
  });

  test("evaluatePreSpawn dispatches wait with a subagent worker descriptor", async () => {
    const captured: Array<PolicyContext & { resourceDescriptor?: RuntimeResource.Descriptor }> = [];
    const createPolicyEngine = PolicyEngine.create;
    const policyEngineSpy = spyOn(PolicyEngine, "create").mockImplementation((options) => {
      const engine = createPolicyEngine(options);
      const dispatch = engine.dispatch;
      engine.dispatch = async (timing, ctx) => {
        captured.push(ctx as PolicyContext & { resourceDescriptor?: RuntimeResource.Descriptor });
        return dispatch(timing, ctx);
      };
      return engine;
    });

    try {
      await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
        operation: "wait",
        sessionId: "worker-session",
      });
    } finally {
      policyEngineSpy.mockRestore();
    }

    expect(captured[0]?.resourceDescriptor).toEqual({
      id: "worker:subagent:wait",
      kind: "worker",
      source: { type: "agent" },
      labels: ["source.agent", "delegation.subagent", "operation.wait"],
      capabilities: ["delegation.wait"],
      effects: [],
    });
  });
});
