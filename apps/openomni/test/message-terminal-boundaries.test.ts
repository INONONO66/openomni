import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { runEffect } from "./helpers/effect";
import { Effect } from "effect";
import { expect, test } from "bun:test";
import { ownerStart } from "./helpers/owner-start";
import { Bus, newTraceId } from "./helpers/bus";
import { Core } from "@openomni/agent";
import { Gateway, SessionTransition } from "@openomni/protocol";
import type { AppLedgerPlane } from "../src/composition/cluster-runtime";
import { planeOf } from "./helpers/ledger";
import { receivedMessages } from "./helpers/received-messages";
import { assistantMessage, commissionInput, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("startOpenOmni reports pre-denied socket admission as an error, not accepted", async () => {
  const app = await suite.boot({
    config: suite.config("message-refusal-", { wsToken: "token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: () => Effect.die(new Error("denied input reached model")),
    },
  });
  const plane = await planeOf(app.runtime);
  plane.stores.channelGrants.put({
    id: "openomni-resident-ws",
    surface: "ws",
    kind: "blocked_channel",
    createdBy: "owner",
  });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "token"]);
  const response = nextFrame(socket, (frame) => frame.type === "receipt" || frame.type === "error");
  socket.send(JSON.stringify({ eventId: newTraceId(), text: "DENIED_INPUT" }));
  expect(await response).toMatchObject({ type: "error" });
  expect(
    plane.listSessions().flatMap((row) => receivedMessages(plane, row.id)),
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
    const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
    const app = await suite.boot({
      config: suite.config("message-child-bound-"),
      sessionRuntime: { clock: () => 100 },
      llm: {
        resolveModel: fakeProviderModel,
        run: (input, sink) => Effect.gen(function* () {
          const runPlane = planeRef.current;
          if (runPlane === undefined) throw new Error("plane not resolved before model run");
          if (runPlane.openKernel(input.trace.sessionId).row(input.trace.sessionId).role === "worker") {
            entered.resolve(input.trace.sessionId);
            if (kind === "interrupted") yield* Effect.promise(() => release.promise);
            if (kind === "error") throw new Error("CHILD_ERROR");
            sink.onMessage(assistantMessage(input, { text: "CHILD_RESULT" }));
            return { type: "stop" };
          }
          if (!commissioned) {
            const output = requestToolStep(input, sink, {
              id: "commission",
              tool: "send_message",
              input: commissionInput({ message: "work", deadline_ms: 900, reply_to: "ORIGINAL" }),
            });
            if (output === undefined) return { type: "stop" };
            expect(output.isError).not.toBe(true);
            commissioned = true;
          }
          sink.onMessage(assistantMessage(input, { text: "PARENT" }));
          return { type: "stop" as const };
        }),
      },
    });
    planeRef.current = await planeOf(app.runtime);
    const plane = planeRef.current;
    await ownerStart(app, "initial");
    if (kind === "interrupted") {
      const childId = await entered.promise;
      const handle = app.sessions.get(childId);
      if (handle === undefined) throw new Error("missing child handle");
      const interrupt = runEffect(handle.interrupt());
      release.resolve();
      await interrupt;
    }
    expect(await delivery).toEqual({ ok: true });
    const child = plane.listSessions().find((row) => row.role === "worker");
    if (child === undefined || child.parentId === null) throw new Error("missing child");
    const terminals = sessionTree(child.id, plane.sessionStore(child.id).actions).flatMap((action) => {
      const terminal = Core.SessionHandleStore.turnTerminal(action);
      return terminal === undefined ? [] : [terminal];
    });
    expect(terminals.map((terminal) => terminal.kind)).toEqual([kind]);
    const letters = receivedMessages(plane, child.parentId).filter(
      (row) => SessionTransition.OutboundMessage.safeParse(row.origin.value).success,
    );
    expect(letters).toHaveLength(1);
    expect(letters[0]?.origin.value).toMatchObject({
      sourceSessionId: child.id,
      replyTo: "ORIGINAL",
      terminal: kind === "result" ? "completed" : kind,
    });
    expect(letters[0]?.content).toBe(terminals[0]?.text);
    // No child-owned request/alarm is opened by the terminal reply.
    expect(
      sessionTree(child.id, plane.sessionStore(child.id).actions).filter((action) => action.kind === "alarm"),
    ).toEqual([]);
    const parentKernel = plane.openKernel(child.parentId);
    expect(parentKernel.requestRows(child.parentId)).toHaveLength(1);
    expect(parentKernel.requestRows(child.parentId)[0]?.state).toBe("resolved");
    expect(
      receivedMessages(plane, child.parentId).filter(
        (row) =>
          row.origin.value !== null &&
          typeof row.origin.value === "object" &&
          !Array.isArray(row.origin.value) &&
          row.origin.value.kind === "message_timeout",
      ),
    ).toEqual([]);
    // W5.2: no alarm rows exist; the resolved request holds no live deadline.
    expect(
      parentKernel
        .requestRows(child.parentId)
        .filter((row) => row.state === "open" && row.deadline !== null && row.deadline <= 1000),
    ).toEqual([]);
  });
}
