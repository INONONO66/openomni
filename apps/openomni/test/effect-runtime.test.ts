import { expect, spyOn, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { Cause, Effect, Exit } from "effect";
import { bootResource } from "../src/composition/boot";
import { gatewayRuntime, runAppBoot } from "../src/gateway";
import { startOpenOmni } from "../src/index";
import { AppClock, AppEntropy, AppLifecycleFailure } from "../src/runtime";

const config = {
  dbPath: ":memory:",
  host: "127.0.0.1",
  wsPort: 0,
  model: { provider: "fake", id: "fixture", apiKey: "fixture" },
};

test("two server edges share the gateway runtime and its injected services", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:", clock: () => 123, entropy: () => "fixed" });
  const first = await startOpenOmni({ config, runtime });
  try {
    const second = await startOpenOmni({ config });
    expect(first.runtime).toBe(runtime);
    expect(second.runtime).toBe(runtime);
    expect(gatewayRuntime({ dbPath: ":memory:" })).toBe(runtime);
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          return [(yield* AppClock).now(), (yield* AppEntropy).next()];
        }),
      ),
    ).toEqual([123, "fixed"]);
    expect((await fetch(`http://127.0.0.1:${first.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${second.port}/health`)).status).toBe(200);
    const stop = first.stop();
    expect(second.stop()).toBe(stop);
    await stop;
    expect(Storage.getInitializedDbPath()).toBeNull();
  } finally {
    await first.stop();
  }
});

test("failed boot releases acquired resources in reverse and rethrows the typed cause", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  const order: string[] = [];
  const failure = new AppLifecycleFailure({ operation: "fixture.acquire", cause: "refused" });
  const incident = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const boot = runAppBoot(
      runtime,
      Effect.gen(function* () {
        yield* bootResource(Effect.succeed("first"), (id) =>
          Effect.sync(() => {
            order.push(id);
          }),
        );
        yield* bootResource(Effect.succeed("second"), (id) =>
          Effect.sync(() => {
            order.push(id);
          }),
        );
        return yield* Effect.fail(failure);
      }),
    );
    await expect(boot).rejects.toBe(failure);
    expect(order).toEqual(["second", "first"]);
    expect(incident.mock.calls[0]?.[1]).toBe(failure);
    expect(Storage.getInitializedDbPath()).toBeNull();
    await runtime.dispose();
    expect(order).toEqual(["second", "first"]);
  } finally {
    incident.mockRestore();
  }
});

test("double stop observes one pending disposal and releases exactly once", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  await runAppBoot(
    runtime,
    bootResource(Effect.void, () =>
      Effect.promise(async () => {
        calls += 1;
        entered.resolve();
        await release.promise;
      }),
    ),
  );
  const first = runtime.dispose();
  const second = runtime.dispose();
  expect(first).toBe(second);
  await entered.promise;
  expect(calls).toBe(1);
  release.resolve();
  await first;
  expect(runtime.dispose()).toBe(first);
  expect(calls).toBe(1);
});

test("scope finalizers all run and aggregate failures in reverse release order", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  const order: string[] = [];
  const first = new AppLifecycleFailure({ operation: "first.close", cause: "first" });
  const second = new AppLifecycleFailure({ operation: "second.close", cause: "second" });
  await runAppBoot(
    runtime,
    Effect.gen(function* () {
      for (const failure of [first, second]) {
        yield* bootResource(Effect.succeed(failure), (error) =>
          Effect.gen(function* () {
            order.push(error.operation);
            return yield* Effect.fail(error);
          }),
        );
      }
    }),
  );
  const exit = await runtime.runPromise(Effect.exit(runtime.disposeEffect));
  expect(order).toEqual(["second.close", "first.close"]);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Array.from(Cause.defects(exit.cause))).toEqual([second, first]);
  expect(Storage.getInitializedDbPath()).toBeNull();
  await runtime.dispose();
});
