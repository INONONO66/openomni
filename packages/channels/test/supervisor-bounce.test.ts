import { expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Schedule } from "effect";
import { z } from "zod";
import { RECONNECT_ATTEMPT_BOUND } from "../src/support/schedule";
import { SocketReconnectShell } from "../src/support/socket-shell";
import { injectedOptions, nthTraceId } from "./helpers/injected";

const messages = {
  urlFetchFailed: "fetch",
  closed: "closed",
  reconnectFailed: "reconnect",
  socketError: "socket",
};

/**
 * #1248: one close starts ONE bounded streak. When every attempt fails, the
 * shell retries exactly `RECONNECT_ATTEMPT_BOUND` times, publishes each
 * failure and the terminal exhaustion on the streak's ONE trace id (D11),
 * then dies: `running` is false, `sendJson` drops, and a later close
 * schedules nothing. Driver death is observable, never an endless loop.
 */
test("a bounded retry streak exhausts into a typed dead shell", async () => {
  const failure = new Error("reconnect unavailable");
  const schema = z.object({ traceId: z.string(), context: z.record(z.string(), z.json()) });
  const events: { name: string; data: z.infer<typeof schema> }[] = [];
  let attempts = 0;
  const reconnectTraces: string[] = [];
  const shell = new SocketReconnectShell(
    (event, data) => {
      events.push({ name: event.name, data: schema.parse(data) });
    },
    messages,
    async () => undefined,
    injectedOptions(),
    // Zero-delay policy: exhaustion is about the bound, not the wall clock.
    Schedule.exponential(0),
  );
  shell.begin();
  await shell.scheduleReconnect(4000, (traceId) => {
    attempts += 1;
    reconnectTraces.push(traceId);
    return Promise.reject(failure);
  });

  expect(attempts).toBe(RECONNECT_ATTEMPT_BOUND);
  expect(shell.running).toBe(false);
  expect(events.map((event) => event.name)).toEqual([
    Operational.Events.Warn.name,
    ...Array.from({ length: RECONNECT_ATTEMPT_BOUND }, () => Operational.Events.Error.name),
    Operational.Events.Error.name,
  ]);
  // ONE trace id for the whole streak: the close notice, every retry, the exhaustion.
  const streakTrace = nthTraceId(1);
  expect(new Set(reconnectTraces)).toEqual(new Set([streakTrace]));
  expect(events.every((event) => event.data.traceId === streakTrace)).toBe(true);
  const terminal = events.at(-1);
  expect(terminal?.data.context).toEqual({
    err: String(failure),
    attempts: RECONNECT_ATTEMPT_BOUND,
  });

  // Dead shell: sends drop, a later close schedules nothing.
  shell.sendJson({ probe: true });
  await shell.scheduleReconnect(4000, () => {
    attempts += 1;
    return Promise.resolve();
  });
  expect(attempts).toBe(RECONNECT_ATTEMPT_BOUND);
});
