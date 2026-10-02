import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { expect, test } from "bun:test";
import { Kernel, type Session } from "@openomni/agent";
const eraseTool = Kernel.eraseTool;
const ExecutorContextError = Kernel.ExecutorContextError;
const ToolRefused = Kernel.ToolRefused;
type SessionEntityTimerContext = Session.SessionEntityTimerContext;
import { Effect, Exit, Cause } from "effect";
import { createMonitorTool } from "../src/tools/monitor";
import {
  createWatchMonitorPorts,
  watchFiredHook,
  watchOccurrenceKey,
  watchState,
  type WatchSpec,
} from "../src/composition/monitor-ports";
import { runEffect } from "./helpers/effect";
import { watchFixture as createWatchFixture } from "./helpers/watch-fixture";

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

const watchSpec = (notificationLimit: number): WatchSpec => ({
  watch: { command: "true", description: "control", persistent: true },
  policyGeneration: 1,
  notificationLimit,
});

async function watchFixture() {
  const { plane, fence, sources, installed, closed } = await createWatchFixture(SESSION, OWNER);
  const ports = createWatchMonitorPorts({
    openKernel: plane.openKernel,
    sources,
    clock: () => 1000,
    entropy: () => "entropy",
    run: (effect) => runEffect(effect),
  });
  return { plane, ports, fence, installed, closed };
}

test("monitor controls fold arm/rearm/cancel as chain facts scoped to the arming session", async () => {
  const fixture = await watchFixture();
  const { plane, ports } = fixture;
  try {
    const monitorTool = createMonitorTool(ports);
    const armed = await ports.arm(
      {
        id: "control",
        sessionId: SESSION,
        kind: "watch",
        fireAt: 1000,
        spec: { encodingVersion: 1, value: watchSpec(8) },
      },
      new AbortController().signal,
    );
    expect(armed).toMatchObject({ id: "control", status: "armed", epoch: 1 });
    expect(fixture.installed).toEqual(["control"]);
    const context = {
      sessionId: SESSION,
      turnId: "turn",
      callId: "call",
      signal: new AbortController().signal,
    };
    // Rearm of a live watch is a no-op: the armed epoch stands.
    expect(
      await monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context),
    ).toMatchObject({ id: "control", status: "armed", epoch: 1 });
    // A foreign session's chain holds no such watch: refused, not cancelled.
    await expect(
      monitorTool.execute(
        { operation: { op: "cancel", id: "control" } },
        { ...context, sessionId: "foreign" },
      ),
    ).rejects.toMatchObject({ _tag: "MonitorRefused" });
    expect(
      await monitorTool.execute({ operation: { op: "cancel", id: "control" } }, context),
    ).toMatchObject({ status: "cancelled", epoch: 1 });
    expect(fixture.closed).toEqual(["control"]);
    // Rearm revives a cancelled watch under the next epoch.
    expect(
      await monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context),
    ).toMatchObject({ id: "control", status: "armed", epoch: 2 });
    expect(fixture.installed).toEqual(["control", "control"]);
  } finally {
    plane.close();
  }
});

test("watchFiredHook commits occurrence, wake prompt, and budget pause as one chain batch", async () => {
  const fixture = await watchFixture();
  const { plane, ports } = fixture;
  try {
    await ports.arm(
      {
        id: "budget",
        sessionId: SESSION,
        kind: "watch",
        fireAt: 1000,
        spec: { encodingVersion: 1, value: watchSpec(2) },
      },
      new AbortController().signal,
    );
    const hookClosed: string[] = [];
    const hook = watchFiredHook({ closeSource: (id) => hookClosed.push(id) });
    const kernel = plane.openKernel(SESSION);
    const context: SessionEntityTimerContext = {
      kernel,
      authority: { sessionId: SESSION, owner: OWNER, fence: fixture.fence },
      now: 1010,
    };
    const fire = (sourceKey: string) =>
      runEffect(
        hook(context, {
          watchId: "budget",
          epoch: 1,
          sourceKey: watchOccurrenceKey("budget", 1, sourceKey),
          batch: JSON.stringify({ content: `WAKE ${sourceKey}`, terminal: false }),
        }),
      );
    expect(await fire("first")).toBe("applied");
    const afterFirst = watchState(kernel, SESSION, "budget");
    expect(afterFirst?.state).toMatchObject({
      status: "armed",
      notifications: 1,
      lastBatch: "WAKE first",
    });
    expect(hookClosed).toEqual([]);
    // Second occurrence exhausts the wake budget: fired + prompt + paused in one commit.
    expect(await fire("second")).toBe("applied");
    const afterSecond = watchState(kernel, SESSION, "budget");
    expect(afterSecond?.state).toMatchObject({ status: "paused", notifications: 2 });
    expect(hookClosed).toEqual(["budget"]);
    // A superseded wake against the paused epoch resolves to noop, not a commit.
    expect(await fire("third")).toBe("noop");
    const prompts = sessionTree(SESSION, plane.sessionStore(SESSION).actions).filter(
      (action) => action.kind === "prompt",
    );
    expect(prompts.map((action) => action.effect.value)).toEqual([
      { inboxKind: "prompt", content: "WAKE first" },
      { inboxKind: "prompt", content: "WAKE second" },
    ]);
    expect(prompts.map((action) => action.intent.value)).toEqual([
      expect.objectContaining({ kind: "alarm", watchId: "budget", epoch: 1 }),
      expect.objectContaining({ kind: "alarm", watchId: "budget", epoch: 1 }),
    ]);
  } finally {
    plane.close();
  }
});
