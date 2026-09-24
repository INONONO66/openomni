import { expect, spyOn, test } from "bun:test";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import { session, createTurnDispatcher, defineTool, eraseTool, sessionTool, type SessionRuntime } from "@openomni/agent";
import { z } from "zod";
import { createResident } from "../src/resident";
import { eventSignal } from "./helpers/event-signal";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { shutdownSessions } from "../src/shutdown";
import { Effect } from "effect";
import { bootResource } from "../src/composition/boot";
import { acquireAppResource, gatewayRuntime, runAppBoot, runAppEffect } from "../src/gateway";
import { installShutdownHandlers } from "../src/index";
import { Clock, GenerationLayers } from "@openomni/agent";
import { AppLifecycleFailure } from "../src/runtime";

test("shutdown stops ingress before session cleanup and awaits cleanup before storage and exit", async () => {
  let now = 100;
  const runtime = gatewayRuntime({ dbPath: ":memory:", clock: () => now });
  const events: (string | number)[] = [];
  const closing = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const handlers = new Map<string, () => void>();
  await runAppBoot(
    runtime,
    Effect.gen(function* () {
      const clock = yield* Clock;
      yield* bootResource(Effect.void, () =>
        Effect.promise(async () => {
          events.push("sessions.close", clock.now());
          closing.resolve();
          await settled.promise;
          events.push("sessions.closed", clock.now());
        }),
      );
      yield* bootResource(Effect.void, () =>
        Effect.sync(() => {
          events.push("ingress.stop");
        }),
      );
    }),
  );
  let stops = 0;
  installShutdownHandlers({
    stop: () => {
      stops += 1;
      return runtime.dispose();
    },
    on: (signal, handler) => {
      handlers.set(signal, handler);
    },
    exit: (code) => {
      expect(Storage.getInitializedDbPath()).toBeNull();
      events.push("exit");
      exited.resolve(code);
    },
  });
  handlers.get("SIGINT")?.();
  handlers.get("SIGTERM")?.();
  await closing.promise;
  expect(stops).toBe(1);
  expect(events).toEqual(["ingress.stop", "sessions.close", 100]);
  expect(Storage.getInitializedDbPath()).toBe(":memory:");
  now = 150;
  settled.resolve();
  expect(await exited.promise).toBe(0);
  expect(events).toEqual(["ingress.stop", "sessions.close", 100, "sessions.closed", 150, "exit"]);
});

test("a cleanup failure is an observed shutdown incident and cannot produce a successful exit", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  const failure = new AppLifecycleFailure({ operation: "sessions.close", cause: "commit_refused" });
  await runAppBoot(
    runtime,
    bootResource(Effect.void, () => Effect.fail(failure)),
  );
  const handlers = new Map<string, () => void>();
  const exited = Promise.withResolvers<number>();
  const incident = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    installShutdownHandlers({
      stop: runtime.dispose,
      on: (signal, handler) => {
        handlers.set(signal, handler);
      },
      exit: exited.resolve,
    });
    handlers.get("SIGTERM")?.();
    expect(await exited.promise).toBe(1);
    expect(incident.mock.calls).toHaveLength(1);
    expect(incident.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(Storage.getInitializedDbPath()).toBeNull();
  } finally {
    incident.mockRestore();
  }
});

for (const settleAfterTurn of [false, true]) {
test(`zero-grace close retains a raw tool lease (settle after turn: ${settleAfterTurn})`, async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:", clock: () => 1000 });
  await runAppBoot(runtime, Effect.void);
  seedKernelPolicyRows();
  const entered = eventSignal<void>("raw tool entered");
  const interrupted = eventSignal<void>("raw tool interrupted");
  const raw = Promise.withResolvers<string>();
  const released = eventSignal<void>("raw lease released");
  const order: string[] = [];
  const tool = eraseTool(defineTool({
    name: "hold_raw", category: "query", description: "Hold a raw tool body",
    input: z.object({}), output: z.string(), visibility: { model: ["resident"], cell: [] },
    execute: (_args, { signal }) => {
      signal.addEventListener("abort", () => { order.push("interrupt"); interrupted.resolve(); }, { once: true });
      entered.resolve();
      return raw.promise;
    },
    render: (_args, output) => output,
  }));
  const sessionRuntime: SessionRuntime = {
    closeGraceMs: 0,
    onHibernate: () => Effect.sync(() => { order.push("lease.released"); released.resolve(); }),
  };
  const resident = createResident({ model: { provider: "test", id: "test" }, apiKey: "test", tools: {}, toolDefinitions: [tool], sessionRuntime });
  await runAppEffect(runtime, Effect.flatMap(GenerationLayers, (generations) => generations.initialize(resident.definitions)));
  const handle = await acquireAppResource(runtime, session({
    id: "shutdown-raw", role: "resident", tools: [sessionTool(tool)],
    runner: (input) => Effect.flatMap(createTurnDispatcher(input, sessionRuntime), (dispatcher) => dispatcher.execute(
      { id: "hold-call", tool: tool.name, input: {} },
      { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
    )).pipe(Effect.as({ kind: "result" as const, text: "settled" })),
  }, sessionRuntime));
  const turn = runAppEffect(runtime, handle.prompt("hold raw tool"));
  try {
    await entered.promise;
    const lease = SessionHandleStore.row(handle.id);
    expect(lease.leaseOwner).not.toBeNull();
    await runAppEffect(runtime, shutdownSessions(sessionRuntime, Promise.resolve()));
    order.push("close.returned");
    await interrupted.promise;
    expect(SessionHandleStore.row(handle.id)).toMatchObject({ leaseOwner: lease.leaseOwner, leaseFence: lease.leaseFence });
    expect(SessionHandleStore.tree(handle.id).some((action) => {
      const value = action.effect.value;
      return value !== null && typeof value === "object" && !Array.isArray(value) && value.terminal === "outcome_unknown";
    })).toBe(true);
    await expect(runtime.dispose()).rejects.toMatchObject({ _tag: "AppLifecycleFailure", operation: "shutdown.raw_unsettled" });
    expect(Storage.getInitializedDbPath()).toBe(":memory:");
    expect(gatewayRuntime({ dbPath: ":memory:" })).toBe(runtime);
    if (settleAfterTurn) await turn;
    raw.resolve("late raw settlement");
    await turn;
    await released.promise;
    expect(order.indexOf("lease.released")).toBeGreaterThan(order.indexOf("close.returned"));
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
  } finally {
    raw.resolve("late raw settlement");
    await turn;
    await runtime.dispose();
  }
});
}
