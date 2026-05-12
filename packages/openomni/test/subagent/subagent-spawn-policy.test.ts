import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PolicyContext } from "@openomni/agent";
import { Session, Storage, WorkerRun } from "@openomni/session";
import { SubagentSpawnPolicyMiddleware } from "../../src/subagent";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const noop = () => undefined;

function middlewareContext(toolName: string): PolicyContext {
  return {
    timing: "pre_tool_use",
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
      action: "abort",
      reason: "denylist",
      policyId: "guardrail.permission",
    });
  });

  test("default denylist ignores non-subagent tool calls", async () => {
    const registration = SubagentSpawnPolicyMiddleware.createDefaultDenylist();

    const verdict = await registration.fn(middlewareContext("read_file"));

    expect(verdict.action).toBe("continue");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  test("session existence policy preserves legacy send error text", async () => {
    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "send",
      sessionId: "missing-session",
    });

    expect(result.verdict).toMatchObject({
      action: "abort",
      reason: "Session not found: missing-session",
      policyId: "guardrail.permission",
    });
  });

  test("session existence policy returns session for valid calls", async () => {
    const session = createSession();

    const result = await SubagentSpawnPolicyMiddleware.evaluatePreSpawn({
      operation: "send",
      sessionId: session.id,
    });

    expect(result.verdict.action).toBe("continue");
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
      action: "abort",
      reason: "Session already has an active run",
      policyId: "guardrail.permission",
    });
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

    expect(result.verdict.action).toBe("continue");
    expect(result.waitTimeoutMs).toBe(80);
    expect(SubagentSpawnPolicyMiddleware.enforceWaitTimeout(undefined, noop)).toBeUndefined();
  });
});
