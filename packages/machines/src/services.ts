import { Context } from "effect";
import type { createMachineHost } from "./host";
import type { attachMachineDaemon } from "./daemon";

export class Machines extends Context.Tag("@openomni/machines/Machines")<Machines, {
  readonly host: typeof createMachineHost;
  readonly attach: typeof attachMachineDaemon;
}>() {}
