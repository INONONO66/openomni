import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Operation, SettledStatus, Transport } from "./schema.js";
import { EpochMs } from "../time.js";

const EventBase = z.object({
  delegationId: z.string().min(1),
  traceId: z.string().min(1),
  time: EpochMs,
});

export const Events = {
  /**
   * The durable record committed: admission is a fact BEFORE any work runs
   * (record-before-act). Replaces the v1 `delegation.requested` — the meaning
   * changed from "admission decided" to "admission persisted", and a changed
   * meaning is a new event type.
   */
  Admitted: BusEvent.define(
    "delegation.admitted",
    EventBase.extend({
      operation: Operation,
      addressKind: z.enum(["core", "actor"]),
      transport: Transport,
      /** Effective deadline (epoch ms) the record was committed under. */
      deadline: EpochMs.int().positive(),
      rootDelegationId: z.string().min(1),
    }),
    { visibility: "llm_reason" },
  ),
  /**
   * The transport acknowledged delivery of the request. Distinct from
   * settlement: a delivered ask/assign still settles later; for notify this
   * ack is the evidence behind the `sent` terminal.
   */
  Delivered: BusEvent.define(
    "delegation.delivered",
    EventBase.extend({ transport: Transport }),
    { visibility: "llm_reason" },
  ),
  Settled: BusEvent.define("delegation.settled", EventBase.extend({ status: SettledStatus }), {
    visibility: "llm_reason",
  }),
} as const;
