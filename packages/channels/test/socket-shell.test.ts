import { expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { SocketReconnectShell } from "../src/support/socket-shell";

const messages = {
  urlFetchFailed: "fetch",
  closed: "closed",
  reconnectFailed: "reconnect",
  socketError: "socket",
};

test("reconnect completion includes terminal failure reporting on the initiating trace", async () => {
  const failure = new Error("reconnect unavailable");
  const schema = z.object({ traceId: z.string(), context: z.record(z.string(), z.json()) });
  const events: { name: string; data: z.infer<typeof schema> }[] = [];
  let delays = 0;
  let reconnectTrace = "";
  const started = Promise.withResolvers<void>();
  const reconnected = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<void>();
  const order: string[] = [];
  const shell = new SocketReconnectShell(
    (event, data) => {
      events.push({ name: event.name, data: schema.parse(data) });
      if (event.name === Operational.Events.Error.name) {
        order.push("reported");
        reported.resolve();
      }
    },
    messages,
    async () => {
      delays += 1;
    },
    async () => undefined,
  );
  shell.begin();
  const scheduled = shell
    .scheduleReconnect(4000, (traceId) => {
      reconnectTrace = traceId;
      started.resolve();
      return reconnected.promise;
    })
    .then(() => {
      order.push("completed");
    });
  await started.promise;
  reconnected.reject(failure);
  await scheduled;
  await reported.promise;
  expect(order).toEqual(["reported", "completed"]);
  expect(delays).toBe(1);
  expect(events.map((event) => event.name)).toEqual([
    Operational.Events.Warn.name,
    Operational.Events.Error.name,
  ]);
  expect(events.map((event) => event.data.traceId)).toEqual([reconnectTrace, reconnectTrace]);
  expect(events[1]?.data.context).toEqual({ err: String(failure) });
  shell.stop();
});
