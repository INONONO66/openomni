import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import * as Machines from "@openomni/machines";
import { Machine } from "@openomni/protocol";
import { startOpenOmni } from "../src";
import * as Gateway from "../src/gateway";
import { SelfAttachError } from "../src/composition/self-machine";
import type { OpenOmniConfig } from "../src/config";
import { runEffect } from "./helpers/effect";
import { socketPath } from "./helpers/socket-path";
import { testSelfMachine } from "./helpers/self-machine";
import { testBus } from "../../../packages/agent/test/helpers/isolated";

function fixtureConfig(machines: OpenOmniConfig["machines"]): OpenOmniConfig {
  return {
    host: "127.0.0.1",
    wsPort: 0,
    kek: { kind: "locked", reason: "no vault key in this fixture" },
    model: { provider: "fake", id: "fixture", apiKey: "fixture" },
    ...(machines === undefined ? {} : { machines }),
  };
}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function track<S extends { mockRestore(): void }>(spy: S): S {
  spies.push(spy);
  return spy;
}

test("boot reaches the attached self state before any tool port exists", async () => {
  const seen: string[][] = [];
  const original = Gateway.toolPorts;
  track(
    spyOn(Gateway, "toolPorts").mockImplementation((runtime, ports) => {
      seen.push(ports.machines === undefined ? [] : ports.machines.list().map((m) => m.machineId));
      return original(runtime, ports);
    }),
  );
  const app = await startOpenOmni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  try {
    expect(seen).toEqual([["self"]]);
  } finally {
    await app.stop();
  }
});

test("a listener that cannot bind fails boot with self_attach_failed", async () => {
  const failed = startOpenOmni({
    config: fixtureConfig({
      self: testSelfMachine(),
      listen: { unix: join(tmpdir(), "om-self-missing-dir", "nested", "machines.sock") },
      enrolled: [],
    }),
  });
  await expect(failed).rejects.toBeInstanceOf(SelfAttachError);
  await expect(failed).rejects.toMatchObject({
    data: { code: "self_attach_failed" },
  });
  await failed.catch((error: SelfAttachError) => {
    expect(error.data.cause).toContain("host listener failed");
  });
});

test("a refused self attachment fails boot closed instead of selecting a local path", async () => {
  track(
    spyOn(Machines, "attachMachineDaemon").mockImplementation(() =>
      Effect.succeed({
        attachment: { status: "refused", reason: "machine_not_enrolled" } as const,
        closed: Effect.void,
        close: () => Effect.void,
      }),
    ),
  );
  const failed = startOpenOmni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  await expect(failed).rejects.toMatchObject({
    data: { code: "self_attach_failed", cause: "machine.attach refused: machine_not_enrolled" },
  });
});

test("missing self exports in an injected config fail boot with self_attach_failed", async () => {
  const failed = startOpenOmni({
    config: fixtureConfig({
      self: { capabilities: ["fs.read"], exports: [] },
      listen: { unix: socketPath() },
      enrolled: [],
    }),
  });
  await expect(failed).rejects.toBeInstanceOf(SelfAttachError);
  await failed.catch((error: SelfAttachError) => {
    expect(error.data.cause).toContain("machine configuration invalid");
  });
});

test("a self daemon that dies during boot fails closed before tool ports publish", async () => {
  const real = Machines.attachMachineDaemon;
  // Silence the lifecycle report; the after-boot test asserts its shape.
  track(spyOn(console, "error").mockImplementation(() => undefined));
  track(
    spyOn(Machines, "attachMachineDaemon").mockImplementation((options) =>
      real(options).pipe(Effect.tap((daemon) => daemon.close())),
    ),
  );
  const failed = startOpenOmni({
    config: fixtureConfig({ self: testSelfMachine(), listen: { unix: socketPath() }, enrolled: [] }),
  });
  await expect(failed).rejects.toBeInstanceOf(SelfAttachError);
  await failed.catch((error: SelfAttachError) => {
    expect(error.data.cause).toContain("self machine disconnected during boot");
  });
});

test("a capability-poor self still boots: a typed refusal proves liveness", async () => {
  const app = await startOpenOmni({
    config: fixtureConfig({
      self: { capabilities: ["shell.exec"], exports: testSelfMachine().exports },
      listen: { unix: socketPath() },
      enrolled: [],
    }),
  });
  await app.stop();
});

test("a self daemon closing after boot detaches the handle and surfaces the typed refusal", async () => {
  const bus = testBus();
  const detached = new Promise<void>((resolve, reject) => {
    bus.observe((observation) => {
      if (observation.name === Machine.Events.Detached.name) resolve();
    });
    AbortSignal.timeout(15_000).addEventListener("abort", () =>
      reject(new Error("timed out waiting for detach")),
    );
  });
  const errors = track(spyOn(console, "error").mockImplementation(() => undefined));
  const real = Machines.attachMachineDaemon;
  let daemon: Machines.MachineDaemon | undefined;
  track(
    spyOn(Machines, "attachMachineDaemon").mockImplementation((options) =>
      real(options).pipe(Effect.tap((attached) => Effect.sync(() => { daemon = attached; }))),
    ),
  );
  const createHost = Machines.createMachineHost;
  let host: Machines.MachineHost | undefined;
  track(
    spyOn(Machines, "createMachineHost").mockImplementation((options) =>
      createHost(options).pipe(Effect.tap((created) => Effect.sync(() => { host = created; }))),
    ),
  );
  const root = testSelfMachine();
  const app = await startOpenOmni({
    runtime: Gateway.gatewayRuntime({ observations: bus }),
    config: fixtureConfig({ self: root, listen: { unix: socketPath() }, enrolled: [] }),
  });
  try {
    if (daemon === undefined || host === undefined) throw new Error("self plane was not captured");
    await runEffect(daemon.close());
    await detached;
    const exportPath = root.exports[0]?.path ?? "/";
    const refusal = await runEffect(Effect.flip(host.get("self").fs.stat(exportPath)));
    expect(refusal).toMatchObject({ _tag: "MachineRefusalError", reason: "disconnected" });
    expect(
      errors.mock.calls.some(
        ([label, error]) => label === "self machine detached" && error instanceof SelfAttachError,
      ),
    ).toBe(true);
  } finally {
    await app.stop();
    bus.close();
  }
});
