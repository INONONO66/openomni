import { expect, test } from "bun:test";
import { join } from "node:path";
import { Bus } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { L0Observation } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { residentSuite, fakeProviderModel } from "./helpers/resident-suite";
import { nextMessage } from "./helpers/ws";

const suite = residentSuite();

test("app monitor source escapes the creating tool wave and wakes a hibernated session", async () => {
  const directory = suite.tempDir("monitor-app-");
  const fifo = join(directory, "source");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("monitor-app-db-", {
      wsToken: "monitor-test",
      compactionSummarizer: false,
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input, sink) => {
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
        return { type: "stop" };
      },
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "monitor-test"]);
  const reply = nextMessage(ws, 5000);
  ws.send(JSON.stringify({ type: "message", text: "watch for the signal" }));
  await reply;
  const alarm = Storage.get().alarms?.due(Number.MAX_SAFE_INTEGER)[0];
  if (alarm === undefined) throw new Error("no created alarm");
  expect(calls).toBe(1);
  expect(alarm.fence).toBe(1); // Already started by the tool-origin bus publication.
  expect(SessionHandleStore.getSnapshot(alarm.sessionId).turns.at(-1)?.terminal?.kind).toBe(
    "waiting",
  );
  expect(app.sessions.get(alarm.sessionId)).toBeUndefined();

  const woke = Promise.withResolvers<void>();
  const guard = AbortSignal.timeout(5000);
  const abort = () => woke.reject(new Error("monitor app wake timed out"));
  guard.addEventListener("abort", abort, { once: true });
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId !== alarm.sessionId || event.kind !== "turn") return;
    if (SessionHandleStore.getSnapshot(alarm.sessionId).turns.at(-1)?.terminal?.kind === "result")
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
  const inbox = SessionHandleStore.inboxRows(alarm.sessionId).filter(
    (row) => row.origin.value === alarm.id,
  );
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({ content: "WAKE", status: "consumed" });
  expect(
    SessionHandleStore.tree(alarm.sessionId).filter((action) => action.kind === "alarm.fired"),
  ).toHaveLength(1);
});
