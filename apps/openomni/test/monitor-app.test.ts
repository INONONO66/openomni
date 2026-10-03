import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Bus, newTraceId } from "./helpers/bus";
import { L0Observation } from "@openomni/protocol";
import { watchState } from "../src/composition/monitor-ports";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";

const suite = residentSuite();

test("app monitor source escapes the creating tool wave and wakes a hibernated session", async () => {
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
  const armed = watchState(kernel, arm.sessionId, arm.watchId);
  expect(armed?.state).toMatchObject({ status: "armed", epoch: 1 }); // Already started by the tool-origin bus publication.
  expect(kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind).toBe(
    "waiting",
  );
  expect(app.sessions.get(arm.sessionId)).toBeUndefined();

  const woke = Promise.withResolvers<void>();
  const guard = AbortSignal.timeout(5000);
  const abort = () => woke.reject(new Error("monitor app wake timed out"));
  guard.addEventListener("abort", abort, { once: true });
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== arm.sessionId || event.kind !== "turn") return;
    if (kernel.getSnapshot(arm.sessionId).turns.at(-1)?.terminal?.kind === "result")
      woke.resolve();
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
  expect(calls).toBe(2);
  const tree = sessionTree(arm.sessionId, plane.sessionStore(arm.sessionId).actions);
  const prompts = tree.filter((action) => {
    if (action.kind !== "prompt") return false;
    const intent = action.intent.value as { kind?: string; watchId?: string };
    return intent.kind === "alarm" && intent.watchId === arm.watchId;
  });
  expect(prompts).toHaveLength(1);
  const prompt = prompts[0];
  if (prompt === undefined) throw new Error("missing watch prompt");
  expect((prompt.effect.value as { content?: string }).content).toContain("WAKE");
  expect(kernel.pendingMessages(arm.sessionId)).not.toContain(prompt.id);
  expect(tree.filter((action) => action.kind === "alarm" && action.id.includes(":occ:"))).toHaveLength(1);
});

/**
 * Monitor door for #1273: a watch attaches read-only to a named tmux
 * terminal (the same kind of session pty.session manages) and wakes on its
 * output; watch completion kills only the attach client, never the terminal.
 */
test("a monitor watch observes a named tmux terminal and leaves it open", async () => {
  const tmuxSocket = `oo-1273-monitor-${process.pid}`;
  expect(
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "new-session", "-d", "-s", "qa", "-x", "80", "-y", "24"]).exitCode,
  ).toBe(0);
  suite.defer(() => {
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"]);
  });
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("monitor-pty-db-", {
      wsToken: "monitor-test",
      compactionSummarizer: false,
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
                  kind: "command",
                  command: `tmux -L ${tmuxSocket} attach -r -t qa`,
                  filter: "WAKE-7342",
                  persistent: true,
                },
              },
            },
          });
        else {
          for (const message of input.messages) for (const part of message.parts) if (part.type === "tool") console.log("PTY-MON part:", JSON.stringify(part.state).slice(0, 300));
          sink.onMessage(assistantMessage(input, { text: "observed terminal" }));
        }
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const waiting = Promise.withResolvers<void>();
  const unsubscribeWaiting = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "waiting") waiting.resolve();
  });
  const waitTimer = setTimeout(() => {
    for (const row of plane.listSessions()) {
      const snap = plane.openKernel(row.id).getSnapshot(row.id);
      console.log("PTY-MON turns:", JSON.stringify(snap.turns.map((turn) => turn.terminal)).slice(0, 400));
      for (const action of sessionTree(row.id, plane.sessionStore(row.id).actions)) if (action.kind === "turn" || action.kind === "alarm") console.log("PTY-MON action:", action.kind, action.id.slice(0, 60));
    }
    waiting.reject(new Error("terminal watch did not suspend"));
  }, 5000);
  try {
    ws.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "watch the terminal" }));
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
  const woke = Promise.withResolvers<void>();
  const guard = AbortSignal.timeout(10_000);
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
  // writer (a bash{session} call, a human) would.
  expect(
    Bun.spawnSync(["tmux", "-L", tmuxSocket, "send-keys", "-t", "qa", "echo WAKE-7342", "Enter"]).exitCode,
  ).toBe(0);
  await woke.promise;
  expect(calls).toBe(2);
  const tree = sessionTree(arm.sessionId, plane.sessionStore(arm.sessionId).actions);
  const prompt = tree.find((action) => {
    if (action.kind !== "prompt") return false;
    const intent = action.intent.value as { kind?: string; watchId?: string };
    return intent.kind === "alarm" && intent.watchId === arm.watchId;
  });
  if (prompt === undefined) throw new Error("missing watch prompt");
  expect((prompt.effect.value as { content?: string }).content).toContain("WAKE-7342");
  // Watch completion unsubscribed from the terminal without closing it.
  const probe = Bun.spawnSync(["tmux", "-L", tmuxSocket, "has-session", "-t", "qa"], { stderr: "pipe" });
  console.log("PTY-MON has-session:", probe.exitCode, probe.stderr.toString());
  console.log("PTY-MON ls:", Bun.spawnSync(["tmux", "-L", tmuxSocket, "list-sessions"], { stderr: "pipe" }).stdout.toString());
  expect(probe.exitCode).toBe(0);
});
