import { expect, test } from "bun:test";
import { Context } from "effect";
import { MachineRefusalError } from "../src/errors";
import { Machines } from "../src/services";

test("machines service and boundary errors expose stable tags", () => {
  const service = {} as Context.Tag.Service<typeof Machines>;
  expect(Machines.key).toBe("@openomni/machines/Machines");
  expect(Context.get(Context.make(Machines, service), Machines)).toBe(service);
  expect(new MachineRefusalError({ reason: "not_found", message: "missing" })._tag).toBe("MachineRefusalError");
});
