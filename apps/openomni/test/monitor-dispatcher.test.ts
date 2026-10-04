import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
const eraseTool = Core.eraseTool;
const ExecutorContextError = Core.ExecutorContextError;
const ToolRefused = Core.ToolRefused;
import { Effect, Exit, Cause } from "effect";
import { createMonitorTool } from "../src/tools/monitor";
import { alarmChainReads, foldAlarmChains } from "../src/composition/alarm-plane";
import { runEffect } from "./helpers/effect";
import { alarmPortsFixture } from "./helpers/watch-fixture";
import { activeInvocation } from "../../../packages/agent/src/core/gate/decide";
import { CRON_TICK } from "../src/composition/bundles/cron";

test("monitor schema and dispatcher keep one strict create/rearm/cancel surface", async () => {
  const monitorTool = createMonitorTool();
  for (const input of [
    {
      op: "create",
      description: "command",
      source: { kind: "command", command: "echo yes", persistent: true },
    },
    {
      op: "create",
      description: "path",
      source: { kind: "path", path: "/tmp/target", event: "modify", timeout_ms: 20 },
    },
    {
      op: "create",
      description: "cron",
      source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
    },
    { op: "rearm", id: "watch" },
    { op: "cancel", id: "watch" },
  ])
    expect(monitorTool.input.safeParse({ operation: input }).success).toBe(true);
  for (const input of [
    { op: "create", description: "no lifetime", source: { kind: "command", command: "echo yes" } },
    {
      op: "create",
      description: "both",
      source: { kind: "command", command: "echo yes", persistent: true, timeout_ms: 1 },
    },
    {
      op: "create",
      description: "regex",
      source: { kind: "command", command: "echo yes", filter: "[", persistent: true },
    },
    {
      op: "create",
      description: "path",
      source: { kind: "path", path: "relative", event: "create", persistent: true },
    },
    {
      // A cron chain's lifecycle is its grid: lifetime fields are a watch concept.
      op: "create",
      description: "cron",
      source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC", persistent: true },
    },
    { op: "cancel", id: "watch", source: { kind: "command", command: "echo wrong" } },
    { op: "rearm" },
  ])
    expect(monitorTool.input.safeParse({ operation: input }).success).toBe(false);
  const dispatcher = dispatcherFixture([eraseTool(monitorTool)]);
  const context = { sessionId: "session", turnId: "turn" };
  expect(
    await runEffect(dispatcher.execute({ id: "bad", tool: "monitor", input: { op: "cancel" } }, context)),
  ).toMatchObject({ errorKind: "invalid_input" });
  expect(
    await runEffect(dispatcher.execute({ id: "missing", tool: "not_monitor", input: {} }, context)),
  ).toMatchObject({ errorKind: "unregistered_tool" });
  const missingContext = await runEffect(Effect.exit(
    dispatcher.execute(
      { id: "context", tool: "monitor", input: { operation: { op: "cancel", id: "watch" } } },
      context,
    ),
  ));
  expect(Exit.isFailure(missingContext)).toBe(true);
  if (Exit.isFailure(missingContext)) {
    expect(
      missingContext.cause.reasons
        .filter(Cause.isDieReason)
        .map((reason) => (reason.defect instanceof ExecutorContextError ? reason.defect : null)),
    ).toEqual([expect.any(ExecutorContextError)]);
  }
  await expect(
    monitorTool.execute(
      { operation: { op: "cancel", id: "watch" } },
      { ...context, callId: "missing-port", signal: new AbortController().signal },
    ),
  ).rejects.toBeInstanceOf(ToolRefused);
});

const OWNER = "watch-test-owner";
const SESSION = "monitor-session";

const watchSpec = (notificationLimit: number) => ({
  watch: { command: "true", description: "control", persistent: true as const },
  policyGeneration: 1,
  notificationLimit,
});

test("monitor controls fold create/rearm/cancel as chain facts scoped to the arming session", async () => {
  const fixture = await alarmPortsFixture({ sessionId: SESSION, owner: OWNER });
  const { state, ports } = fixture;
  try {
    // Enough committed history that the fold and the rearm's spec recovery
    // must page (`historyPage` default limit 100) instead of reading one page.
    const filler = Array.from({ length: 110 }, (_, index) => ({
      id: `filler-${index + 1}`,
      parentId: index === 0 ? null : `filler-${index}`,
      sessionId: SESSION,
      kind: "llm" as const,
      intent: { encodingVersion: 1 as const, value: { phase: "intent" } },
      effect: { encodingVersion: 1 as const, value: { phase: "pending" } },
      irreversible: true as const,
      ts: 2,
    }));
    await runEffect(
      state.kernel.commit({
        sessionId: SESSION,
        owner: OWNER,
        fence: state.fence,
        now: 2,
        expectedRevision: state.kernel.row(SESSION).revision,
        actions: filler,
        state: "idle",
      }),
    );
    const monitorTool = createMonitorTool(ports);
    const armed = await ports.create(
      { id: "control", sessionId: SESSION, turnId: "turn", kind: "watch", spec: watchSpec(8) },
      new AbortController().signal,
    );
    expect(armed).toMatchObject({ id: "control", kind: "watch", status: "armed", fireAt: 1000 });
    expect(state.installed.map((spec) => spec.id)).toEqual(["control"]);
    const context = {
      sessionId: SESSION,
      turnId: "turn",
      callId: "call",
      signal: new AbortController().signal,
    };
    // Rearm of a live watch is a no-op: the armed chain stands.
    expect(
      await monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context),
    ).toMatchObject({ id: "control", status: "armed", occurrenceId: armed.occurrenceId });
    // A chain the session never armed is refused, not cancelled.
    await expect(
      monitorTool.execute({ operation: { op: "cancel", id: "ghost" } }, context),
    ).rejects.toMatchObject({ _tag: "MonitorRefused" });
    expect(
      await monitorTool.execute({ operation: { op: "cancel", id: "control" } }, context),
    ).toMatchObject({ status: "cancelled", fireAt: null });
    expect(state.closed).toEqual(["control"]);
    // Rearm revives the cancelled chain under a fresh occurrence.
    const revived = await monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context);
    expect(revived).toMatchObject({ id: "control", status: "armed", notifications: 0 });
    expect(revived.occurrenceId).not.toBe(armed.occurrenceId);
    expect(state.installed.map((spec) => spec.id)).toEqual(["control", "control"]);
  } finally {
    state.plane.close();
  }
});

test("capability wakes spend the chain budget: prompt, re-arm, then exhaustion retire", async () => {
  // The prompt append is the entity's (`AlarmWakeContext.prompt`); here it is
  // recorded so the chain budget, re-arm and retire are what the test proves.
  const prompts: { content: string; payload?: unknown }[] = [];
  const prompt: Bundle.AlarmPromptVerb = (input) => {
    prompts.push(input);
    return Effect.succeed({ seq: prompts.length });
  };
  const fixture = await alarmPortsFixture({ sessionId: SESSION, owner: OWNER });
  const { state, capability, arm } = fixture;
  const kernel = state.plane.openKernel(SESSION);
  const wake = (content: string) => {
    const chain = foldAlarmChains(kernel, SESSION).get("budget");
    if (chain === undefined || chain.latest.at === null) throw new Error("no armed chain");
    const notice = [...fixture.notices]
      .reverse()
      .find((candidate) => candidate.occurrenceId === chain.latest.occurrenceId);
    if (notice === undefined) throw new Error("unobserved arm");
    return runEffect(
      capability.wake(
        {
          occurrenceId: chain.latest.occurrenceId,
          purpose: Bundle.MONITOR_HIT,
          alarmId: "budget",
          armSeq: notice.armSeq,
          sourceKey: Bundle.MONITOR_SOURCE,
          payload: JSON.stringify({
            spec: chain.latest.payload.spec,
            notifications: chain.latest.payload.notifications,
            hit: { content, terminal: false, detail: "line:1" },
          }),
          fireAt: 1000,
        },
        {
          sessionId: SESSION,
          reads: alarmChainReads(kernel, SESSION),
          arm: arm(SESSION),
          now: 1010,
          prompt,
        },
      ),
    );
  };
  try {
    await fixture.ports.create(
      { id: "budget", sessionId: SESSION, turnId: "turn", kind: "watch", spec: watchSpec(2) },
      new AbortController().signal,
    );
    expect(await wake("WAKE first")).toBe("delivered");
    const afterFirst = foldAlarmChains(kernel, SESSION).get("budget");
    expect(afterFirst?.latest).toMatchObject({ at: 1010, payload: { notifications: 1 } });
    expect(state.closed).toEqual([]);
    // The second wake spends the whole budget: prompt + exhaustion retire.
    expect(await wake("WAKE second")).toBe("exhausted");
    const afterSecond = foldAlarmChains(kernel, SESSION).get("budget");
    expect(afterSecond?.latest).toMatchObject({ at: null, payload: { reason: "exhausted" } });
    // The handler closes the native source AND the retiring arm's hook does:
    // close is idempotent fire-and-forget, so the overlap is harmless.
    expect(state.closed).toEqual(["budget", "budget"]);
    expect(prompts).toEqual([
      { content: "WAKE first", payload: { watchId: "budget", detail: "line:1" } },
      { content: "WAKE second", payload: { watchId: "budget", detail: "line:1" } },
    ]);
  } finally {
    state.plane.close();
  }
});

/** A compiled tool/pre snapshot the invocation frame carries into `evaluateGate`. */
function monitorPolicy(extraRows: readonly Record<string, unknown>[] = []) {
  return Core.compilePolicySnapshot({
    registry: Core.KERNEL_POLICY_REGISTRY,
    generation: 1,
    mandatory: [],
    rows: [
      ...Core.SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
      ...extraRows,
    ] as Parameters<typeof Core.compilePolicySnapshot>[0]["rows"],
  });
}

test("cron create validates the grid and consults the gate before arming the chain", async () => {
  const fixture = await alarmPortsFixture({ sessionId: SESSION, owner: OWNER });
  const { state, ports, scheduled } = fixture;
  try {
    const monitorTool = createMonitorTool(ports);
    const context = {
      sessionId: SESSION,
      turnId: "turn",
      callId: "call",
      signal: new AbortController().signal,
    };
    const cron = (expr: string) => ({
      op: "create" as const,
      description: "five minute grid",
      source: { kind: "cron" as const, expr, tz: "UTC" },
    });
    const run = (
      policy: ReturnType<typeof monitorPolicy>,
      operation: ReturnType<typeof cron>,
    ) =>
      activeInvocation.run(
        {
          executor: {} as never,
          captured: { executor: {} as never, cell: {} as never, policy, generation: {} as never },
        },
        () => monitorTool.execute({ operation }, context),
      );
    // An invalid expression is refused before the gate and before any commit.
    await expect(run(monitorPolicy(), cron("not a cron"))).rejects.toMatchObject({
      name: "ToolRefused",
      message: expect.stringContaining("invalid cron expression"),
    });
    // A deny verdict refuses the arm: no chain row, no scheduled occurrence.
    const deny = monitorPolicy([{
      name: "deny-monitor",
      kind: "tool",
      phase: "pre",
      generation: 1,
      priority: 2000,
      match: { encodingVersion: 1, value: { op: "monitor" } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "monitors are off" } },
    }]);
    await expect(run(deny, cron("*/5 * * * *"))).rejects.toMatchObject({
      name: "ToolRefused",
      message: "monitor refused: cron arm denied",
    });
    expect(foldAlarmChains(state.plane.openKernel(SESSION), SESSION).size).toBe(0);
    expect(scheduled).toEqual([]);
    // An allowed grid arms one cron chain at the next boundary and schedules it.
    const armed = await run(monitorPolicy(), cron("*/5 * * * *"));
    expect(armed).toMatchObject({ id: "minted", kind: "cron", status: "armed", notifications: 0 });
    // fixture clock 1000 -> the next */5 UTC boundary is 1970-01-01T00:05:00Z.
    expect(armed.fireAt).toBe(300_000);
    expect(scheduled).toMatchObject([
      { alarmId: "minted", purpose: CRON_TICK, fireAt: 300_000 },
    ]);
  } finally {
    state.plane.close();
  }
});
