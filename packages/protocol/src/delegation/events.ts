import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Lane, Mode, SettledStatus } from "./schema.js";

const EventBase = z.object({
  delegationId: z.string().min(1),
  traceId: z.string().min(1),
  time: z.number(),
});

export const Events = {
  /** Admission settled: the kernel resolved an address onto a lane. */
  Requested: BusEvent.define(
    "delegation.requested",
    EventBase.extend({
      addressKind: z.enum(["core", "actor"]),
      mode: Mode,
      lane: Lane,
    }),
    { visibility: "llm_reason" },
  ),
  Settled: BusEvent.define("delegation.settled", EventBase.extend({ status: SettledStatus }), {
    visibility: "llm_reason",
  }),
} as const;
