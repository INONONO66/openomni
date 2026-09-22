import { expect, test } from "bun:test";
import {
  closeSessions,
  createDispatcher,
  createObservationBus,
  createSessionRequests,
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
import { LedgerWrites, SessionHandleStore, Storage } from "@openomni/ledger";
import { Effect, Scope, Exit, Cause } from "effect";
import type { RunInput, Sink } from "@openomni/llm";
import { createMonitorPorts, gatewayRuntime } from "../src/gateway";
import { createAlarmWorker } from "../src/composition/alarm-worker";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { createMonitorTool } from "../src/tools/monitor";
import { assistantMessage } from "./helpers/assistant-message";
import { runEffect } from "./helpers/effect";

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
  const dispatcher = createDispatcher([eraseTool(monitorTool)]);
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
    expect([...Cause.defects(missingContext.cause)]).toEqual([expect.any(ExecutorContextError)]);
  }
  await expect(
    monitorTool.execute(
      { operation: { op: "cancel", id: "watch" } },
      { ...context, callId: "missing-port", signal: new AbortController().signal },
    ),
  ).rejects.toBeInstanceOf(ToolRefused);
});

test("monitor controls enforce session identity and throw on refused transitions", () =>
  Storage.withIsolation(async () => {
    const appRuntime = gatewayRuntime({ dbPath: ":memory:", clock: () => 1000 });
    const ports = await createMonitorPorts(appRuntime);
    const monitorTool = createMonitorTool(ports);
    try {
      await appRuntime.runPromise(
        Effect.gen(function* () {
          const ledger = yield* LedgerWrites;
          yield* ledger.sessions.create({
            id: "monitor-session",
            parentId: null,
            role: "resident",
            state: "idle",
            revision: 0,
            leaseOwner: null,
            leaseFence: 0,
            leaseExpiresAt: null,
            toolsGeneration: 0,
            systemHash: "",
            policyGeneration: 1,
          });
        }),
      );
      await ports.arm(
        {
          id: "control",
          sessionId: "monitor-session",
          kind: "watch",
          fireAt: 1000,
          spec: {
            encodingVersion: 1,
            value: {
              watch: { command: "true", description: "control", persistent: true },
              notificationLimit: 8,
              policyGeneration: 1,
            },
          },
        },
        new AbortController().signal,
      );
      const context = {
        sessionId: "monitor-session",
        turnId: "turn",
        callId: "call",
        signal: new AbortController().signal,
      };
      expect(
        await monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context),
      ).toMatchObject({
        id: "control",
        epoch: 2,
      });
      await expect(
        monitorTool.execute(
          { operation: { op: "cancel", id: "control" } },
          { ...context, sessionId: "foreign" },
        ),
      ).rejects.toMatchObject({
        _tag: "MonitorRefused",
        errorKind: "precondition_failed",
        failure: {
          _tag: "AlarmRefused",
          operation: "cancel",
          reason: "session",
          alarmId: "control",
        },
      });
      expect(
        await monitorTool.execute({ operation: { op: "cancel", id: "control" } }, context),
      ).toMatchObject({
        status: "cancelled",
      });
      await expect(
        monitorTool.execute({ operation: { op: "rearm", id: "control" } }, context),
      ).rejects.toMatchObject({
        _tag: "MonitorRefused",
        errorKind: "precondition_failed",
        failure: { _tag: "AlarmRefused", operation: "rearm", reason: "state", alarmId: "control" },
      });
    } finally {
      await appRuntime.dispose();
    }
  }));

test("monitor create seals live-wait with one model call; PTY inbox wakes a hibernated session", () =>
  Storage.withIsolation(async () => {
    const events = createObservationBus();
    const appRuntime = gatewayRuntime({ dbPath: ":memory:", observations: events });
    const monitorTool = createMonitorTool(await createMonitorPorts(appRuntime));
    const storage = Storage.get();
    if (storage.alarms === undefined) throw new Error("fixture alarm storage missing");
    seedKernelPolicyRows();
    const runtime: SessionRuntime = { observations: events };
    const scope = await runEffect(Scope.make());
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
              resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
              run: (request: RunInput, sink: Sink) => Effect.sync(() => {
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
                return { type: "stop" as const };
              }),
            },
          },
        };
      },
    });
    const handle = await runEffect(Scope.extend(session(
      { id: "live-wait", role: "resident", runner, tools: definitions.map(sessionTool) },
      runtime,
    ), scope));
    const woke = Promise.withResolvers<void>();
    const errors: Error[] = [];
    const worker = await runEffect(Scope.extend(createAlarmWorker({
      alarms: storage.alarms,
      requestTimeout: createSessionRequests(runtime).timeout,
      observations: events,
      schedule: () => () => undefined,
      failure: (error) => {
        errors.push(error);
        woke.reject(error);
      },
      wake: (id: string) => Scope.extend(wakeSession(id, runner, runtime), scope).pipe(
        Effect.tap(() => Effect.sync(() => woke.resolve())), Effect.asVoid,
      ),
    }), scope));
    try {
      const result = await runEffect(handle.prompt("watch and wait"));
      expect(result?.kind).toBe("waiting");
      expect(calls).toBe(1);
      expect(getSessionHandle(handle.id, runtime)).toBeUndefined();
      const guard = AbortSignal.timeout(5000);
      const abort = () => woke.reject(new Error("alarm did not wake hibernated session"));
      guard.addEventListener("abort", abort, { once: true });
      await runEffect(worker.start());
      await woke.promise;
      guard.removeEventListener("abort", abort);
      expect(calls).toBe(2);
      expect(
        SessionHandleStore.tree(handle.id).filter((action) => action.kind === "alarm.fired"),
      ).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await runEffect(worker.close());
      await runEffect(closeSessions(runtime));
      await runEffect(Scope.close(scope, Exit.void));
      await appRuntime.dispose();
    }
  }));
