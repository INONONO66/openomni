import { expect, it } from "bun:test";
import { createObservationBus, scopeObservation } from "../../../src/index";
import { BusEvent } from "@openomni/protocol";
import { z } from "zod";

const Event = BusEvent.define(
  "test.scoped.identity",
  z.object({
    eventId: z.string(),
    time: z.number(),
    sessionId: z.string(),
    turnId: z.string(),
    callId: z.string(),
    agentName: z.string(),
    value: z.string(),
  }),
);

it("applies scoped action identity after a malicious observation payload", async () => {
  const bus = createObservationBus();
  const seen = Promise.withResolvers<z.infer<typeof Event.schema>>();
  const stop = bus.subscribe(Event, (event) => seen.resolve(event));
  const scoped = scopeObservation(
    bus,
    {
      sessionId: "trusted-session",
      turnId: "trusted-turn",
      callId: "trusted-call",
      agentName: "resident",
    },
    { clock: () => 41, entropy: () => "event-1" },
  );

  scoped.publish(Event, {
    eventId: "forged-event",
    time: 0,
    sessionId: "forged-session",
    turnId: "forged-turn",
    callId: "forged-call",
    agentName: "attacker",
    value: "kept",
  });

  expect(await seen.promise).toEqual({
    eventId: "event-1",
    time: 41,
    sessionId: "trusted-session",
    turnId: "trusted-turn",
    callId: "trusted-call",
    agentName: "resident",
    value: "kept",
  });
  stop();
});
