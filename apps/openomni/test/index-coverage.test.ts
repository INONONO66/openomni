import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Core } from "@openomni/agent";
type ExecutionApprovalRequest = Core.ExecutionApprovalRequest;
import { Bus, newTraceId } from "./helpers/bus";
import { Effect } from "effect";
const CommitRefused = Core.CommitRefused;
import { L0Observation } from "@openomni/protocol";
import type { AppSessionHandle } from "../src";
import {
  assistantMessage,
  requestToolStep,
} from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { bounded } from "./helpers/protected-dispatch";
import { runEffect } from "./helpers/effect";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { waveTool } from "./helpers/session-wave";
import { nextFrame } from "./helpers/ws";
import { approvalPolicy } from "./helpers/approval-policy";

const suite = residentSuite();

test.each(["revision", "fence"] as const)(
  "facade interrupt handles a %s commit refusal",
  async (reason) => {
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const app = await suite.boot({
      config: suite.config(`index-interrupt-${reason}-`, { wsToken: "interrupt-token" }),
      llm: {
        resolveModel: fakeProviderModel,
        run: (input) => Effect.gen(function* () {
          entered.resolve(input.trace.sessionId);
          yield* Effect.promise(() => release.promise);
          return { type: "stop" as const };
        }),
      },
    });
    const plane = await planeOf(app.runtime);
    const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "interrupt-token"]);
    socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "interrupt this turn" }));
    const sessionId = await bounded(entered.promise);
    const handle = app.sessions.get(sessionId);
    if (handle === undefined) throw new Error("live turn missing");
    const original = plane.openKernel;
    let commits = 0;
    const spy = spyOn(plane, "openKernel").mockImplementation((id) => {
      const kernel = original(id);
      if (id !== sessionId) return kernel;
      const commit: typeof kernel.commit = (input) => {
        const effect = input.actions[0]?.effect.value;
        if (
          effect === null || typeof effect !== "object" ||
          Array.isArray(effect) || effect.inboxKind !== "interrupt"
        ) return kernel.commit(input);
        commits += 1;
        if (commits > 1) return kernel.commit(input);
        const row = kernel.row(id);
        return Effect.fail(new CommitRefused({
          sessionId: id, reason,
          expectedRevision: input.expectedRevision, currentRevision: row.revision + 1,
          fence: input.fence, currentFence: row.fence,
        }));
      };
      return { ...kernel, commit };
    });
    try {
      if (reason === "revision") {
        await bounded(runEffect(handle.interrupt()));
        expect(commits).toBe(2);
      } else {
        const failure = await bounded(runEffect(Effect.flip(handle.interrupt())));
        expect(failure).toMatchObject({ _tag: "AgentFailure", operation: "session.interrupt" });
        expect(commits).toBe(1);
      }
    } finally {
      spy.mockRestore();
      release.resolve();
    }
  },
);

test("live approval readiness notifies the facade and arms its deadline", async () => {
  const modelEntered = Promise.withResolvers<string>();
  const releaseModel = Promise.withResolvers<void>();
  let calls = 0;
  const running = await suite.boot({
    config: suite.config("index-live-approval-", { wsToken: "index-token" }),
    toolDefinitions: [waveTool("B", async () => "approved")],
    sessionRuntime: { approvalTimeoutMs: 60_000 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            yield* Effect.promise(() => {
              modelEntered.resolve(input.trace.sessionId);
              return releaseModel.promise;
            });
            requestToolStep(input, sink, {
              id: "approval-call",
              tool: "B",
              input: { slot: "B" },
            });
          } else {
            sink.onMessage(assistantMessage(input, { text: "approved" }));
          }
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(running.runtime);
  expect(
    plane.catalog.policies.append(approvalPolicy("index-approval")),
  ).toBe(true);
  const waiting = Promise.withResolvers<{
    readonly handle: AppSessionHandle;
    readonly request: ExecutionApprovalRequest;
  }>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const handle = running.sessions.get(event.sessionId);
    const request = handle?.approvals.pending()[0];
    if (handle !== undefined && request !== undefined) waiting.resolve({ handle, request });
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${running.port}/ws`, [
    "auth",
    "index-token",
  ]);
  const response = nextResidentTurn(plane, 5000);

  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "request approval" }));

  const sessionId = await bounded(modelEntered.promise);
  expect(running.sessions.get(sessionId)).toBeDefined();
  const kernel = plane.openKernel(sessionId);
  releaseModel.resolve();
  const { handle, request } = await bounded(waiting.promise);
  expect(request.expiresAt).toBeGreaterThan(0);
  const latestGenerationFor = kernel.latestGenerationFor;
  Object.defineProperty(kernel, "latestGenerationFor", {
    configurable: true,
    value: () => {
      throw new Error("corrupt generation fixture");
    },
  });
  const answerReceipt = nextFrame(socket, (frame) => frame.type === "receipt");
  socket.send(
    JSON.stringify({
      type: "request_answer",
      inputId: "index-wired-approval-answer",
      request: request.durable,
      decision: "approve",
      credential: "index-token",
    }),
  );
  try {
    expect(await answerReceipt).toMatchObject({
      inputId: "index-wired-approval-answer",
      result: { status: "executed" },
    });
    expect(kernel.requestById(request.durable.requestId)?.state).toBe("resolved");
  } finally {
    Object.defineProperty(kernel, "latestGenerationFor", {
      configurable: true,
      value: latestGenerationFor,
    });
  }
  expect(await response).toMatchObject({ text: "approved" });
  await running.stop();
  expect(
    await runEffect(
      Effect.flip(handle.requests.timeout("stale-request", Date.now())).pipe(Effect.orDie),
    ),
  ).toMatchObject({ code: "approval_authority_unavailable" });
});

test("a path watch timeout reaches the session entity", async () => {
  const directory = suite.tempDir("index-watch-timeout-");
  const watched = join(directory, "watched");
  writeFileSync(watched, "stable");
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("index-watch-timeout-db-", { wsToken: "index-watch-token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.sync(() => {
          calls += 1;
          if (calls === 1)
            requestToolStep(input, sink, {
              id: "watch-timeout-call",
              tool: "monitor",
              input: {
                operation: {
                  op: "create",
                  description: "timeout coverage",
                  source: { kind: "path", path: watched, event: "modify", timeout_ms: 20 },
                },
              },
            });
          else sink.onMessage(assistantMessage(input, { text: "timed out" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const fired = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind === "alarm.fired") fired.resolve();
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, [
    "auth",
    "index-watch-token",
  ]);

  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "create timeout watch" }));

  await bounded(fired.promise);
  expect(calls).toBeGreaterThanOrEqual(1);
  expect(plane.listSessions().some((row) => row.id !== "gateway-ingress")).toBe(true);
});

test("a deadline-bearing external send opens and arms its live request", async () => {
  let sent = false;
  const modelWaiting = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  const sendEntered = Promise.withResolvers<void>();
  const releaseSend = Promise.withResolvers<void>();
  const config = suite.config("index-deadline-send-", {
    wsToken: "index-send-token",
    actors: [
      {
        actorId: "owner",
        externalId: "owner",
        kind: "human",
        trustTier: "owner",
      },
      {
        actorId: "peer",
        externalId: "peer",
        kind: "ai_agent",
        trustTier: "assigned_worker",
      },
    ],
    socialBudgets: [
      {
        id: "peer-budget",
        targetActorId: "peer",
        maxPerWindow: 5,
        windowMs: 1000,
        cooldownMs: 0,
      },
    ],
  });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.gen(function* () {
          if (!sent) {
            yield* Effect.promise(() => {
              sendEntered.resolve();
              return releaseSend.promise;
            });
            const result = requestToolStep(input, sink, {
              id: "deadline-send",
              tool: "send_message",
              input: {
                to: { kind: "contact", id: "peer" },
                message: "DEADLINE_QUESTION",
                deadline_ms: 60_000,
              },
            });
            if (result === undefined) return { type: "stop" as const };
            sent = true;
          }
          yield* Effect.promise(() => {
            modelWaiting.resolve();
            return releaseModel.promise;
          });
          sink.onMessage(assistantMessage(input, { text: "DEADLINE_WAITING" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const owner = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    "index-send-token",
  ]);
  const peer = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=peer`, [
    "auth",
    "index-send-token",
  ]);
  const question = nextFrame(peer, (frame) => frame.type === "message");
  const terminal = nextResidentTurn(plane, 5000);
  const deadlineFailure = spyOn(console, "error").mockImplementation(() => undefined);
  suite.defer(() => deadlineFailure.mockRestore());

  owner.send(JSON.stringify({ eventId: newTraceId(), text: "send with deadline" }));

  await bounded(sendEntered.promise);
  if (config.catalogPath === undefined) throw new Error("missing test catalog");
  const catalog = new Database(config.catalogPath);
  catalog.exec(
    "CREATE TRIGGER refuse_deadline_message BEFORE INSERT ON cluster_messages BEGIN SELECT RAISE(ABORT, 'forced deadline refusal'); END",
  );
  catalog.close();
  releaseSend.resolve();
  const delivery = await question;
  expect(delivery).toMatchObject({ text: "DEADLINE_QUESTION" });
  if (delivery.type !== "message") throw new Error("missing deadline question");
  await bounded(modelWaiting.promise);
  const liveSource = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (liveSource === undefined) throw new Error("missing live source session");
  expect(app.sessions.get(liveSource.id)).toBeDefined();
  const receipt = nextFrame(peer, (frame) => frame.type === "receipt");
  peer.send(
    JSON.stringify({
      text: "DEADLINE_ANSWER",
      replyToId: delivery.messageId,
      eventId: "index-deadline-answer",
    }),
  );
  expect(await receipt).toMatchObject({ status: "accepted" });
  releaseModel.resolve();
  await terminal;
  expect(deadlineFailure).toHaveBeenCalled();
  const source = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (source === undefined) throw new Error("missing source session");
  expect(
    plane
      .openKernel(source.id)
      .requestRows(source.id)
      .some((request) => request.deadline !== null),
  ).toBe(true);
});
