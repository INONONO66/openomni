import { describe, expect, test } from "bun:test";
import type { Delegation } from "@openomni/protocol";
import { createDriverRegistry } from "../src/composition/driver-registry";
import type { Admitted } from "../src/delegation/admission";
import type { DelegationDriver, DriverOutcome } from "../src/delegation/kernel";

// The wrapper forwards these opaquely; the registry never inspects them.
const admitted = {} as Admitted;
const handle = {} as Delegation.Handle;
const signal = new AbortController().signal;

function completed(output: string): DriverOutcome {
  return { status: "completed", output };
}

/** A driver whose run resolves only when the test says so. */
function deferredDriver(output: string): {
  driver: DelegationDriver;
  finish: () => void;
} {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    driver: {
      async run() {
        await gate;
        return completed(output);
      },
    },
    finish: () => release?.(),
  };
}

describe("delegation driver registry", () => {
  test("a run resolved before a swap completes under its own generation", async () => {
    const registry = createDriverRegistry();
    const old = deferredDriver("old-generation");
    registry.register("inline", old.driver);

    const resolved = registry.drivers.inline;
    expect(resolved).toBeDefined();
    const inFlight = resolved?.run(admitted, handle, signal);

    // Swap while the old generation still holds work.
    registry.register("inline", { run: async () => completed("new-generation") });

    // New dispatches see only the new generation.
    const next = await registry.drivers.inline?.run(admitted, handle, signal);
    expect(next).toEqual(completed("new-generation"));

    // The pinned run still answers from the driver that accepted it.
    old.finish();
    expect(await inFlight).toEqual(completed("old-generation"));
  });

  test("drain resolves exactly when the last in-flight run returns", async () => {
    const registry = createDriverRegistry();
    const slow = deferredDriver("done");
    const registration = registry.register("inline", slow.driver);

    const run = registry.drivers.inline?.run(admitted, handle, signal);
    expect(registration.inFlight()).toBe(1);
    const drained = registration.drain().then(() => "drained" as const);

    // While the run is held open, the drain promise cannot have settled:
    // an already-resolved sentinel wins the race deterministically.
    expect(await Promise.race([drained, Promise.resolve("pending" as const)])).toBe("pending");

    slow.finish();
    await run;
    expect(await drained).toBe("drained");
    expect(registration.inFlight()).toBe(0);
  });

  test("drain outlives the first return while a second run is still in flight", async () => {
    const registry = createDriverRegistry();
    const releases: (() => void)[] = [];
    const registration = registry.register("inline", {
      run: () =>
        new Promise<DriverOutcome>((resolve) => {
          releases.push(() => resolve(completed("ok")));
        }),
    });

    const first = registry.drivers.inline?.run(admitted, handle, signal);
    const second = registry.drivers.inline?.run(admitted, handle, signal);
    expect(registration.inFlight()).toBe(2);
    const drained = registration.drain().then(() => "drained" as const);

    // The first return must not settle the drain: one run still holds work.
    releases[0]?.();
    await first;
    expect(await Promise.race([drained, Promise.resolve("pending" as const)])).toBe("pending");

    releases[1]?.();
    await second;
    expect(await drained).toBe("drained");
    expect(registration.inFlight()).toBe(0);
  });

  test("drain on an idle registration resolves immediately", async () => {
    const registry = createDriverRegistry();
    const registration = registry.register("process", {
      run: async () => completed("unused"),
    });
    await registration.drain();
    expect(registration.inFlight()).toBe(0);
  });

  test("a rejecting run is still counted out of its generation", async () => {
    const registry = createDriverRegistry();
    const registration = registry.register("inline", {
      run: () => Promise.reject(new Error("driver exploded")),
    });
    await expect(registry.drivers.inline?.run(admitted, handle, signal)).rejects.toThrow(
      "driver exploded",
    );
    await registration.drain();
    expect(registration.inFlight()).toBe(0);
  });

  test("disposing a replaced registration never evicts its successor", () => {
    const registry = createDriverRegistry();
    const first = registry.register("inline", { run: async () => completed("first") });
    const second = registry.register("inline", { run: async () => completed("second") });
    expect(second.generation).toBeGreaterThan(first.generation);

    first.dispose();
    expect(registry.drivers.inline).toBeDefined();

    second.dispose();
    expect(registry.drivers.inline).toBeUndefined();
  });

  test("generations are monotone per transport, independent across transports", () => {
    const registry = createDriverRegistry();
    const inline1 = registry.register("inline", { run: async () => completed("a") });
    const inline2 = registry.register("inline", { run: async () => completed("b") });
    const channel1 = registry.register("channel", { run: async () => completed("c") });
    expect(inline1.generation).toBe(1);
    expect(inline2.generation).toBe(2);
    expect(channel1.generation).toBe(1);
  });

  test("the wrapper mirrors prepare exactly: present when present, absent when absent", async () => {
    const registry = createDriverRegistry();
    registry.register("channel", {
      prepare: () => ({ waitId: "wait-42" }),
      run: async () => completed("with-prepare"),
    });
    registry.register("inline", { run: async () => completed("without-prepare") });

    expect(registry.drivers.channel?.prepare).toBeDefined();
    expect(await registry.drivers.channel?.prepare?.(admitted, handle)).toEqual({
      waitId: "wait-42",
    });
    expect(registry.drivers.inline?.prepare).toBeUndefined();
  });

  test("an unregistered transport reads as undefined, never a default", () => {
    const registry = createDriverRegistry();
    expect(registry.drivers.process).toBeUndefined();
    expect(registry.drivers.channel).toBeUndefined();
  });
});
