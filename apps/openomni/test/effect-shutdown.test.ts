import { expect, spyOn, test } from "bun:test";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import { session, type SessionRunner, type SessionRuntime } from "@openomni/agent";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { shutdownSessions } from "../src/shutdown";
import { Effect } from "effect";
import { bootResource } from "../src/composition/boot";
import { gatewayRuntime, runAppBoot } from "../src/gateway";
import { installShutdownHandlers } from "../src/index";
import { AppClock, AppObservations, AppLifecycleFailure } from "../src/runtime";

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
      const clock = yield* AppClock;
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

test("current zero-grace session close interrupts but retains the unresolved raw runner lease", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:", clock: () => 1000 });
  const services = await runAppBoot(
    runtime,
    Effect.gen(function* () {
      return { clock: yield* AppClock, observations: yield* AppObservations };
    }),
  );
  seedKernelPolicyRows();
  const entered = Promise.withResolvers<void>();
  const raw = Promise.withResolvers<Awaited<ReturnType<SessionRunner>>>();
  const released = Promise.withResolvers<void>();
  const order: string[] = [];
  const sessionRuntime: SessionRuntime = {
    observations: services.observations,
    clock: services.clock.now,
    closeGraceMs: 0,
    onHibernate: () => {
      order.push("lease.released");
      released.resolve();
    },
  };
  const handle = session(
    {
      id: "shutdown-raw",
      role: "resident",
      runner: ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            order.push("interrupt");
          },
          { once: true },
        );
        entered.resolve();
        return raw.promise;
      },
    },
    sessionRuntime,
  );
  const turn = handle.prompt("hold raw runner");
  try {
    await entered.promise;
    const lease = SessionHandleStore.row(handle.id);
    expect(lease.leaseOwner).not.toBeNull();
    await runtime.runPromise(shutdownSessions(sessionRuntime, Promise.resolve()));
    order.push("close.returned");
    expect(order).toEqual(["interrupt", "close.returned"]);
    expect(SessionHandleStore.row(handle.id)).toMatchObject({
      leaseOwner: lease.leaseOwner,
      leaseFence: lease.leaseFence,
    });
    raw.resolve({ kind: "result", text: "late raw settlement" });
    await turn;
    await released.promise;
    expect(order).toEqual(["interrupt", "close.returned", "lease.released"]);
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
  } finally {
    raw.resolve({ kind: "result", text: "late raw settlement" });
    await turn;
    await runtime.dispose();
  }
});
