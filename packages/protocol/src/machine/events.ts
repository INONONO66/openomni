import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { CapabilityId, MachineId } from "./schema.js";

const EventBase = z.object({
  machineId: MachineId,
  time: z.number(),
});

export const Events = {
  /** A daemon attached and negotiation settled: this is the effective set in force. */
  Attached: BusEvent.define(
    "machine.attached",
    EventBase.extend({ effectiveCapabilities: z.array(CapabilityId) }),
    { visibility: "llm_reason" },
  ),
  Detached: BusEvent.define("machine.detached", EventBase.extend({ reason: z.string().min(1) }), {
    visibility: "llm_reason",
  }),
} as const;
