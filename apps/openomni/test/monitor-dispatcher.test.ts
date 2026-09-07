import { expect, test } from "bun:test";
import {
  closeSessions,
  createDispatcher,
  createObservationBus,
  createSessionChatRunner,
  createTurnDispatcher,
  eraseTool,
  ExecutorContextError,
  getSessionHandle,
  session,
  sessionTool,
  ToolRefused,
  wakeSession,
  type SessionRuntime,
} from "@openomni/agent";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { createAlarmWorker } from "../src/composition/alarm-worker";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { monitorTool } from "../src/tools/mutation/monitor";
import { assistantMessage } from "./helpers/assistant-message";
import { alarmFixture } from "./helpers/alarm";

test("monitor schema and dispatcher keep one strict create/rearm/cancel surface", async () => {
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
    { op: "rearm", alarmId: "watch" },
    { op: "cancel", alarmId: "watch" },
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
    { op: "cancel", alarmId: "watch", source: { kind: "command", command: "echo wrong" } },
    { op: "rearm" },
  ])
    expect(monitorTool.input.safeParse({ operation: input }).success).toBe(false);
  const dispatcher = createDispatcher([eraseTool(monitorTool)]);
  const context = { sessionId: "session", turnId: "turn" };
  expect(
    await dispatcher.execute({ id: "bad", tool: "monitor", input: { op: "cancel" } }, context),
  ).toMatchObject({ errorKind: "invalid_input" });
  expect(
    await dispatcher.execute({ id: "missing", tool: "not_monitor", input: {} }, context),
  ).toMatchObject({ errorKind: "unregistered_tool" });
  await expect(
    dispatcher.execute(
      { id: "context", tool: "monitor", input: { operation: { op: "cancel", alarmId: "watch" } } },
      context,
    ),
  ).rejects.toThrow(ExecutorContextError);
});

test("monitor controls enforce session identity and throw on refused transitions", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      fixture.arm("control", { command: "true", description: "control", persistent: true });
      const context = {
        sessionId: "monitor-session",
        turnId: "turn",
        callId: "call",
        signal: new AbortController().signal,
      };
      expect(
        await monitorTool.execute({ operation: { op: "rearm", alarmId: "control" } }, context),
      ).toMatchObject({
        id: "control",
        epoch: 2,
      });
      await expect(
        monitorTool.execute(
          { operation: { op: "cancel", alarmId: "control" } },
          { ...context, sessionId: "foreign" },
        ),
      ).rejects.toThrow(ToolRefused);
      expect(
        await monitorTool.execute({ operation: { op: "cancel", alarmId: "control" } }, context),
      ).toMatchObject({
        status: "cancelled",
      });
      await expect(
        monitorTool.execute({ operation: { op: "rearm", alarmId: "control" } }, context),
      ).rejects.toThrow(ToolRefused);
    } finally {
      await fixture.close();
    }
  }));

test("monitor create seals live-wait with one model call; PTY inbox wakes a hibernated session", () =>
  Storage.withIsolation(async () => {
    const events = createObservationBus();
    const storage = new SqliteStorageAdapter(":memory:", events);
    Storage.configure(storage);
    seedKernelPolicyRows();
    const runtime: SessionRuntime = { observations: events };
    const definitions = [eraseTool(monitorTool)];
    let calls = 0;
    const runner = createSessionChatRunner({
      prepare(input) {
        const dispatcher = createTurnDispatcher(definitions, input, runtime);
        return {
          traceContext: {
            traceId: "monitor-trace",
            sessionId: input.sessionId,
            runId: input.resultId,
          },
          config: {
            events,
            executor: dispatcher.executor,
            model: { provider: "test", id: "test" },
            tools: [...dispatcher.specs],
            toolWave: (wave, signal) =>
              dispatcher.executeWave(wave, {
                sessionId: input.sessionId,
                turnId: input.turnId,
                signal,
              }),
            toolExecutor: (call) =>
              dispatcher.execute(call, { sessionId: input.sessionId, turnId: input.turnId }),
            llm: {
              resolveModel: async () => ({ providerID: "test", id: "test", name: "test" }),
              run: async (request, sink) => {
                calls += 1;
                const message = assistantMessage(request, {
                  text: calls === 1 ? "waiting" : "observed",
                });
                if (calls === 1)
                  message.parts.push({
                    id: "monitor-part",
                    messageID: message.info.id,
                    sessionID: input.sessionId,
                    type: "tool",
                    callID: "monitor-call",
                    tool: "monitor",
                    state: {
                      status: "pending",
                      input: {
                        operation: {
                          op: "create",
                          description: "wake",
                          source: {
                            kind: "command",
                            command: "printf 'WAKE\\n'; read value",
                            filter: "^WAKE$",
                            persistent: true,
                          },
                        },
                      },
                    },
                  });
                sink.onMessage(message);
                return { type: "stop" };
              },
            },
          },
        };
      },
    });
    const handle = session(
      { id: "live-wait", role: "resident", runner, tools: definitions.map(sessionTool) },
      runtime,
    );
    const woke = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const worker = createAlarmWorker({
      alarms: storage.alarms,
      observations: events,
      schedule: () => () => undefined,
      failure: (error) => {
        errors.push(error);
        woke.reject(error);
      },
      async wake(id) {
        await wakeSession(id, () => runner, runtime);
        woke.resolve();
      },
    });
    try {
      const result = await handle.prompt("watch and wait");
      expect(result?.kind).toBe("waiting");
      expect(calls).toBe(1);
      expect(getSessionHandle(handle.id, runtime)).toBeUndefined();
      const guard = AbortSignal.timeout(5000);
      const abort = () => woke.reject(new Error("alarm did not wake hibernated session"));
      guard.addEventListener("abort", abort, { once: true });
      worker.start();
      await woke.promise;
      guard.removeEventListener("abort", abort);
      expect(calls).toBe(2);
      expect(
        SessionHandleStore.tree(handle.id).filter((action) => action.kind === "alarm.fired"),
      ).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await worker.close();
      await closeSessions(runtime);
      Storage.reset();
    }
  }));
