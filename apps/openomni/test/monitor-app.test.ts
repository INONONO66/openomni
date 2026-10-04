import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Bus, newTraceId } from "./helpers/bus";
import { L0Observation } from "@openomni/protocol";
import { foldAlarmChains, watchStateOf } from "../src/composition/alarm-plane";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { attachMachineDaemon } from "@openomni/machines";
import { acquireEffect, runEffect } from "./helpers/scoped-effect";
import { testIds } from "./helpers/test-entropy";
import { testSelfMachine } from "./helpers/self-machine";

const suite = residentSuite();

test("app monitor source escapes the creating tool wave and wakes the session on its hit", async () => {
  const directory = suite.tempDir("monitor-app-");
  const fifo = join(directory, "source");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  let calls = 0;
  const waiting = Promise.withResolvers<void>();
  const app = await suite.boot({
    config: suite.config("monitor-app-db-", {
      wsToken: "monitor-test",
      compactionSummarizer: false,
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        if (calls === 1)
          requestToolStep(input, sink, {
            id: "monitor-create",
            tool: "monitor",
            input: {
              operation: {
                op: "create",
                description: "external signal",
                source: {
                  kind: "command",
                  command: `cat '${fifo}'; read value`,
                  filter: "^WAKE$",
                  persistent: true,
                },
              },
            },
          });
        else sink.onMessage(assistantMessage(input, { text: "observed" }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const plane = await planeOf(app.runtime);
  // W5.2: entity turns never call the hibernate hook (their port is a no-op);
  // the durable suspend signal is the turn terminal "waiting" commit.
  const unsubscribeWaiting = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "waiting") waiting.resolve();
  });
  const waitTimer = setTimeout(() => waiting.reject(new Error("monitor did not suspend")), 5000);
  try {
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "watch for the signal" }));
    await waiting.promise;
  } finally {
    clearTimeout(waitTimer);
    unsubscribeWaiting();
  }
  const arm = plane
    .listSessions()
    .flatMap((row) =>
      sessionTree(row.id, plane.sessionStore(row.id).actions)
        .filter((action) => action.kind === "alarm" && action.id.includes(":arm:"))
        .map((action) => ({ sessionId: row.id, watchId: action.id.split(":arm:")[0] ?? "" })),
    )[0];
  if (arm === undefined) throw new Error("no created watch");
  const kernel = plane.openKernel(arm.sessionId);
  expect(calls).toBe(1);
  const chain = foldAlarmChains(kernel, arm.sessionId).get(arm.watchId);
  if (chain === undefined) throw new Error("no armed chain");
  expect(watchStateOf(chain, arm.sessionId)).toMatchObject({
    kind: "watch",
    status: "armed",
    notifications: 0,
  });
  expect(kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind).toBe(
    "waiting",
  );
  expect(app.sessions.get(arm.sessionId)).toBeUndefined();

  // #1254 S4: the native hit resends the ARMED occurrence through the entity's
  // alarm door; the composed monitor capability wakes the session with one
  // alarm prompt and re-arms the persistent chain under the next occurrence.
  const woke = Promise.withResolvers<void>();
  const guard = AbortSignal.timeout(10_000);
  const abort = () => woke.reject(new Error("monitor hit never woke the session"));
  guard.addEventListener("abort", abort, { once: true });
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== arm.sessionId || event.kind !== "turn") return;
    if (kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind === "result") woke.resolve();
  });
  suite.defer(() => {
    unsubscribe();
    guard.removeEventListener("abort", abort);
  });
  // FIFO open is a rendezvous with the actual PTY reader, not a readiness delay.
  const writer = Bun.spawn(["/bin/sh", "-c", `printf 'WAKE\\n' > '${fifo}'`]);
  suite.defer(async () => {
    if (writer.exitCode === null) writer.kill();
    await writer.exited;
  });
  await woke.promise;
  expect(await writer.exited).toBe(0);
  // One matching line is one wake: a second turn ran over one alarm prompt
  // carrying the hit, and nothing else.
  expect(calls).toBe(2);
  const tree = sessionTree(arm.sessionId, plane.sessionStore(arm.sessionId).actions);
  const alarmPrompts = tree.filter((action) => {
    if (action.kind !== "prompt") return false;
    const intent = action.intent.value as { kind?: string; alarmId?: string };
    return intent.kind === "alarm" && intent.alarmId === arm.watchId;
  });
  expect(alarmPrompts).toHaveLength(1);
  expect((alarmPrompts[0]?.effect.value as { content?: string }).content).toBe("WAKE");
  // The chain settled the fired occurrence once and re-armed under a new one.
  expect(tree.filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered"))).toHaveLength(1);
  const rearmed = foldAlarmChains(kernel, arm.sessionId).get(arm.watchId);
  if (rearmed === undefined) throw new Error("chain lost after the hit");
  expect(watchStateOf(rearmed, arm.sessionId)).toMatchObject({ status: "armed", notifications: 1 });
  expect(rearmed.latest.occurrenceId).not.toBe(chain.latest.occurrenceId);
});

/**
 * Monitor door for #1273 item 6: a terminal watch subscribes to the daemon's
 * pty cursor and drains reads beyond it — never a screen client. A tmux
 * attach repaint re-delivers already-visible lines (CI runs 37148697651 red /
 * 37149686062 green on the same test: a paint/live race), which the cursor
 * makes impossible: each retained byte is returned at most once, so one new
 * matching line is exactly one wake. Watch completion never closes the terminal.
 */
test("a monitor watch observes a named tmux terminal and leaves it open", async () => {
  const tmuxSocket = `oo-1273-monitor-${process.pid}`;
  suite.defer(() => {
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"]);
  });
  const machinesSocket = join(suite.tempDir("monitor-pty-machines-"), "machines.sock");
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("monitor-pty-db-", {
      wsToken: "monitor-test",
      compactionSummarizer: false,
      machines: {
        self: testSelfMachine(),
        listen: { unix: machinesSocket },
        enrolled: [{
          name: "workstation",
          machineId: "m-1",
          allowedCapabilities: ["pty.session"],
          allowedExports: ["shell"],
          publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          enrolledAt: 1000,
        }],
      },
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        if (calls === 1)
          requestToolStep(input, sink, {
            id: "monitor-pty-create",
            tool: "monitor",
            input: {
              operation: {
                op: "create",
                description: "named terminal signal",
                source: {
                  kind: "terminal",
                  machine: "m-1",
                  session: "qa",
                  filter: "WAKE-7342",
                  persistent: true,
                },
              },
            },
          });
        else sink.onMessage(assistantMessage(input, { text: "observed terminal" }));
        return { type: "stop" as const };
      }),
    },
  });
  // The machine body: a daemon offering pty.session over a private tmux socket.
  const daemon = await acquireEffect(attachMachineDaemon({
    socketPath: machinesSocket,
    id: testIds("monitor-pty-daemon"),
    offer: {
      machineId: "m-1",
      daemonVersion: "0.1.0",
      platform: "darwin",
      offeredAt: 2000,
      offeredCapabilities: ["pty.session"],
      exports: [{ name: "shell", path: "/" }],
    },
    fsExports: new Map([["shell", "/"]]),
    pty: { socketName: tmuxSocket },
  }));
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const waiting = Promise.withResolvers<void>();
  const unsubscribeWaiting = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "waiting") waiting.resolve();
  });
  const waitTimer = setTimeout(() => waiting.reject(new Error("terminal watch did not suspend")), 10_000);
  try {
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "watch the terminal" }));
    // The waiting commit lands only after install's subscribe (open-or-reattach
    // + cursor baseline), so the trigger below cannot race the subscription.
    await waiting.promise;
  } finally {
    clearTimeout(waitTimer);
    unsubscribeWaiting();
  }
  // The watch's open created the terminal through the daemon.
  expect(Bun.spawnSync(["tmux", "-L", tmuxSocket, "has-session", "-t", "qa"], { stderr: "pipe" }).exitCode).toBe(0);
  const arm = plane
    .listSessions()
    .flatMap((row) =>
      sessionTree(row.id, plane.sessionStore(row.id).actions)
        .filter((action) => action.kind === "alarm" && action.id.includes(":arm:"))
        .map((action) => ({ sessionId: row.id, watchId: action.id.split(":arm:")[0] ?? "" })),
    )[0];
  if (arm === undefined) throw new Error("no created watch");
  const kernel = plane.openKernel(arm.sessionId);
  const woke = Promise.withResolvers<void>();
  const guard = AbortSignal.timeout(15_000);
  const abort = () => woke.reject(new Error("terminal watch wake timed out"));
  guard.addEventListener("abort", abort, { once: true });
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== arm.sessionId || event.kind !== "turn") return;
    if (kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind === "result") woke.resolve();
  });
  suite.defer(() => {
    unsubscribe();
    guard.removeEventListener("abort", abort);
  });
  // The terminal's owner is the tmux server: feed it directly, as any other
  // writer (a bash{session} call, a human) would. printf's format string keeps
  // the typed keystroke echo from matching (-l types it literally; Enter is a
  // separate key event, immune to key-name parsing differences).
  expect(
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "send-keys", "-t", "qa", "-l", "printf 'WAKE-%d\\n' 7342"]).exitCode,
  ).toBe(0);
  expect(Bun.spawnSync(["tmux", "-L", tmuxSocket, "send-keys", "-t", "qa", "Enter"]).exitCode).toBe(0);
  await woke.promise;
  // Exactly one wake for one new matching line: the cursor drain returns each
  // retained byte at most once, so no repaint or replay can double-fire.
  expect(calls).toBe(2);
  const tree = sessionTree(arm.sessionId, plane.sessionStore(arm.sessionId).actions);
  const prompts = tree.filter((action) => {
    if (action.kind !== "prompt") return false;
    const intent = action.intent.value as { kind?: string; alarmId?: string };
    return intent.kind === "alarm" && intent.alarmId === arm.watchId;
  });
  expect(prompts).toHaveLength(1);
  const prompt = prompts[0];
  if (prompt === undefined) throw new Error("missing watch prompt");
  expect((prompt.effect.value as { content?: string }).content).toContain("WAKE-7342");
  expect(tree.filter((action) => action.kind === "alarm" && action.id.endsWith(":delivered"))).toHaveLength(1);
  // Watch cancellation/daemon shutdown never close the terminal: the tmux
  // server owns it.
  await runEffect(daemon.close());
  const probe = Bun.spawnSync(["tmux", "-L", tmuxSocket, "has-session", "-t", "qa"], { stderr: "pipe" });
  expect(probe.exitCode).toBe(0);
}, 60_000);

/**
 * #1254 cron chains through the real tool door, end to end: the create commits
 * the arm, schedules the occurrence WITHOUT blocking on its DeliverAt reply
 * (which only answers at `fireAt`), and the turn suspends on live-wait
 * evidence. Expression/gate refusals are unit-covered in monitor-dispatcher.
 */
test("monitor cron create arms a grid chain and the turn suspends instead of blocking on the tick", async () => {
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("monitor-cron-db-", {
      wsToken: "monitor-test",
      compactionSummarizer: false,
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        calls += 1;
        if (calls === 1)
          requestToolStep(input, sink, {
            id: "cron-create",
            tool: "monitor",
            input: {
              operation: {
                op: "create",
                description: "five minute grid",
                source: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
              },
            },
          });
        else sink.onMessage(assistantMessage(input, { text: "cron armed" }));
        return { type: "stop" as const };
      }),
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const plane = await planeOf(app.runtime);
  const waiting = Promise.withResolvers<void>();
  const unsubscribeWaiting = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "waiting") waiting.resolve();
  });
  const waitTimer = setTimeout(() => waiting.reject(new Error("cron create did not suspend")), 15_000);
  try {
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "arm the cron" }));
    await waiting.promise;
  } finally {
    clearTimeout(waitTimer);
    unsubscribeWaiting();
  }
  // One model call: the create returned promptly (the DeliverAt reply is NOT
  // awaited) and the loop suspended on the armed chain's live-wait evidence.
  expect(calls).toBe(1);
  const session = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (session === undefined) throw new Error("no resident session");
  const kernel = plane.openKernel(session.id);
  const chains = [...foldAlarmChains(kernel, session.id).values()];
  expect(chains).toHaveLength(1);
  const chain = chains[0];
  if (chain === undefined) throw new Error("no cron chain");
  const state = watchStateOf(chain, session.id);
  expect(state).toMatchObject({ kind: "cron", status: "armed", notifications: 0 });
  if (state.fireAt === null) throw new Error("armed cron without a fire instant");
  // The scheduled instant is the grid's next UTC five-minute boundary, in the future.
  expect(state.fireAt % 60_000).toBe(0);
  expect(new Date(state.fireAt).getUTCMinutes() % 5).toBe(0);
  expect(state.fireAt).toBeGreaterThan(Date.now());
}, 30_000);
