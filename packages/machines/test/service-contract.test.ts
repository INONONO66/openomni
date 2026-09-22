import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { attachMachineDaemon, createMachineHost } from "../src/index";
import { MachineRefusalError } from "../src/errors";
import { Machines } from "../src/services";
import { acquire, run } from "../../ipc/test/helpers/effects";
import { socketPath } from "./helpers/socket-path";

test("machines service runs the native host and preserves boundary error tags", async () => {
  const service = { host: createMachineHost, attach: attachMachineDaemon };
  expect(Machines.key).toBe("@openomni/machines/Machines");
  const resolved = Context.get(Context.make(Machines, service), Machines);
  expect(resolved).toBe(service);
  const { value: host, close } = await acquire(resolved.host({
    socketPath: socketPath(), enrollment: () => undefined,
    events: { publish: (): void => undefined }, now: (): number => 1,
  }));
  try {
    expect(host.list()).toEqual([]);
    expect(await run(Effect.flip(host.get("missing").exec("true", "/")))).toMatchObject({
      _tag: "MachineRefusalError", reason: "machine_not_attached",
    });
    const failure = new MachineRefusalError({ reason: "not_found", message: "missing" });
    expect(await run(Effect.flip(failure))).toBe(failure);
  } finally {
    await close();
  }
});
