import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
const eraseTool = Core.eraseTool;
const ExecutorContextError = Core.ExecutorContextError;
const ToolRefused = Core.ToolRefused;
import { Effect, Exit, Cause } from "effect";
import { createMonitorTool } from "../src/tools/monitor";
import { alarmChainReads, createAlarmPromptPort, foldAlarmChains } from "../src/composition/alarm-plane";
import { runEffect } from "./helpers/effect";
import { alarmPortsFixture } from "./helpers/watch-fixture";

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
    const monitorTool = createMonitorTool(ports);
    const armed = await ports.create(
      { id: "control", sessionId: SESSION, kind: "watch", spec: watchSpec(8) },
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
  // #1254 S4: ctx.prompt — the test binds the real prompt port per wake origin
  // exactly the way Lane 4's dispatch will.
  let origin = { alarmId: "", occurrenceId: "", purpose: "", sourceKey: "" };
  let promptFor: ReturnType<typeof createAlarmPromptPort> | undefined;
  const prompt: Bundle.AlarmPromptVerb = (input) => {
    if (promptFor === undefined) return Effect.die(new Error("prompt before fixture"));
    return promptFor(SESSION, origin)(input);
  };
  const fixture = await alarmPortsFixture({ sessionId: SESSION, owner: OWNER, prompt });
  promptFor = createAlarmPromptPort({ openKernel: fixture.state.plane.openKernel, clock: () => 1010 });
  const { state, capability, arm } = fixture;
  const kernel = state.plane.openKernel(SESSION);
  const wake = (content: string) => {
    const chain = foldAlarmChains(kernel, SESSION).get("budget");
    if (chain === undefined || chain.latest.at === null) throw new Error("no armed chain");
    const notice = [...fixture.notices]
      .reverse()
      .find((candidate) => candidate.occurrenceId === chain.latest.occurrenceId);
    if (notice === undefined) throw new Error("unobserved arm");
    origin = {
      alarmId: "budget",
      occurrenceId: chain.latest.occurrenceId,
      purpose: Bundle.MONITOR_HIT,
      sourceKey: Bundle.MONITOR_SOURCE,
    };
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
        { sessionId: SESSION, reads: alarmChainReads(kernel, SESSION), arm: arm(SESSION), now: 1010 },
      ),
    );
  };
  try {
    await fixture.ports.create(
      { id: "budget", sessionId: SESSION, kind: "watch", spec: watchSpec(2) },
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
    const prompts = sessionTree(SESSION, state.plane.sessionStore(SESSION).actions).filter(
      (action) => action.kind === "prompt",
    );
    expect(prompts.map((action) => action.effect.value)).toEqual([
      { inboxKind: "prompt", content: "WAKE first" },
      { inboxKind: "prompt", content: "WAKE second" },
    ]);
    expect(prompts.map((action) => action.intent.value)).toEqual([
      expect.objectContaining({ kind: "alarm", alarmId: "budget", purpose: "monitor.hit" }),
      expect.objectContaining({ kind: "alarm", alarmId: "budget", purpose: "monitor.hit" }),
    ]);
  } finally {
    state.plane.close();
  }
});
