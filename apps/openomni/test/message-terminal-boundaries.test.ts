import { expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { ChannelGrantStore, SessionHandleStore, Storage } from "@openomni/ledger";
import { Gateway, Inbox } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("startOpenOmni reports pre-denied socket admission as an error, not accepted", async () => {
  const app = await suite.boot({
    config: suite.config("message-refusal-", { wsToken: "token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: async () => {
        throw new Error("denied input reached model");
      },
    },
  });
  ChannelGrantStore.put({
    id: "openomni-resident-ws",
    surface: "ws",
    kind: "blocked_channel",
    createdBy: "owner",
  });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "token"]);
  const response = nextFrame(socket, (frame) => frame.type === "receipt" || frame.type === "error");
  socket.send(JSON.stringify({ text: "DENIED_INPUT" }));
  expect(await response).toMatchObject({ type: "error" });
  expect(
    SessionHandleStore.listRows().flatMap((row) => SessionHandleStore.inboxRows(row.id)),
  ).toEqual([]);
});

for (const kind of ["result", "error", "interrupted"] as const) {
  test(`startOpenOmni deadline-bound child delivers ${kind} under the original request`, async () => {
    let commissioned = false;
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const timer = setTimeout(() => delivered.reject(new Error("missing child terminal")), 5000);
    const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => {
      if (event.kind === "message.replied") delivered.resolve();
      if (
        event.kind === "message.rejected" &&
        event.matchedRuleIds.includes("message.worker.deadline")
      ) {
        delivered.reject(new Error("terminal refused by inherited deadline"));
      }
    });
    // Attach rejection before triggering the runner, including the RED case.
    const delivery = delivered.promise.then(
      () => ({ ok: true }),
      (error: Error) => ({ ok: false, error }),
    );
    suite.defer(() => {
      clearTimeout(timer);
      unsubscribe();
      release.resolve();
    });
    const app = await suite.boot({
      config: suite.config("message-child-bound-"),
      sessionRuntime: { clock: () => 100 },
      llm: {
        resolveModel: fakeProviderModel,
        run: async (input, sink) => {
          if (SessionHandleStore.row(input.trace.sessionId).role === "worker") {
            entered.resolve(input.trace.sessionId);
            if (kind === "interrupted") await release.promise;
            if (kind === "error") throw new Error("CHILD_ERROR");
            sink.onMessage(assistantMessage(input, { text: "CHILD_RESULT" }));
            return { type: "stop" };
          }
          if (!commissioned) {
            const output = requestToolStep(input, sink, {
              id: "commission",
              tool: "sendMessage",
              input: {
                to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
                type: "message",
                content: "work",
                deadline: 1000,
                replyTo: "ORIGINAL",
              },
            });
            if (output === undefined) return { type: "stop" };
            expect(output.isError).not.toBe(true);
            commissioned = true;
          }
          sink.onMessage(assistantMessage(input, { text: "PARENT" }));
          return { type: "stop" };
        },
      },
    });
    await app.gateway.ingest(
      { kind: "external", surface: "ws", externalId: "owner" },
      {
        eventId: "initial",
        surface: "ws",
        channelId: "owner",
        addressees: [],
        dm: true,
        payload: {},
        render: "start",
      },
    );
    if (kind === "interrupted") {
      const childId = await entered.promise;
      const handle = app.sessions.get(childId);
      if (handle === undefined) throw new Error("missing child handle");
      const interrupt = handle.interrupt();
      release.resolve();
      await interrupt;
    }
    expect(await delivery).toEqual({ ok: true });
    const child = SessionHandleStore.listRows().find((row) => row.role === "worker");
    if (child === undefined || child.parentId === null) throw new Error("missing child");
    const terminals = SessionHandleStore.tree(child.id).flatMap((action) => {
      const terminal = SessionHandleStore.turnTerminal(action);
      return terminal === undefined ? [] : [terminal];
    });
    expect(terminals.map((terminal) => terminal.kind)).toEqual([kind]);
    const letters = SessionHandleStore.inboxRows(child.parentId).filter(
      (row) => Inbox.ReplyOrigin.safeParse(row.origin.value).success,
    );
    expect(letters).toHaveLength(1);
    expect(letters[0]?.origin.value).toMatchObject({
      kind: "child_terminal",
      childSessionId: child.id,
      replyTo: "ORIGINAL",
      terminalKind: kind,
    });
    expect(letters[0]?.content).toBe(terminals[0]?.text);
    // No child-owned request/alarm is opened by the terminal reply.
    expect(
      SessionHandleStore.tree(child.id).filter((action) => action.kind === "alarm.arm"),
    ).toEqual([]);
    expect(
      SessionHandleStore.tree(child.parentId).filter((action) => action.kind === "alarm.arm"),
    ).toHaveLength(1);
    expect(SessionHandleStore.expireMessageDeadlines(1000)).toEqual([]);
    expect(
      SessionHandleStore.inboxRows(child.parentId).filter(
        (row) =>
          row.origin.value !== null &&
          typeof row.origin.value === "object" &&
          !Array.isArray(row.origin.value) &&
          row.origin.value.kind === "message_timeout",
      ),
    ).toEqual([]);
    expect(Storage.get().alarms?.due(1000)).toEqual([]);
  });
}
