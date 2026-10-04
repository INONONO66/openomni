import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bundle, Core } from "@openomni/agent";
type ExecutionApprovalRequest = Core.ExecutionApprovalRequest;
import { Bus, newTraceId } from "./helpers/bus";
import { Effect } from "effect";
const CommitRefused = Core.CommitRefused;
import { canonicalDigest, L0Observation } from "@openomni/protocol";
import type { AppSessionHandle } from "../src";
import {
  assistantMessage,
  requestToolStep,
} from "./helpers/assistant-message";
import { adoptTestFence, planeOf } from "./helpers/ledger";
import { foldAlarmChains, watchStateOf } from "../src/composition/alarm-plane";
import { testMachinesPlane } from "./helpers/self-machine";
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

test("a stale owner answer with no live turn rides the entity Resolve and is rejected", async () => {
  // #1253: a session that is neither live in this process nor a process
  // runner answers out-of-turn through the entity's Resolve RPC; a typed
  // ResolveRefused (unknown request here) surfaces as the `rejected`
  // resolution and the receipt frame, never a dead socket.
  const app = await suite.boot({
    config: suite.config("index-stale-resolve-", { wsToken: "stale-token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: () => Effect.sync(() => ({ type: "stop" as const })),
    },
  });
  const plane = await planeOf(app.runtime);
  const sessionId = "stale-resolve-target";
  await runEffect(
    plane.openKernel(sessionId).materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: 1,
    }),
  );
  plane.catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
  const parsedInput = { slot: "ghost" };
  const request = {
    requestId: "ghost-request",
    sessionId,
    turnId: null,
    callId: "ghost-call",
    mode: "approval",
    parsedInput,
    inputHash: canonicalDigest(parsedInput),
    effectHash: "ghost-effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "ghost-tools",
    systemHash: "ghost-system",
    domainRevisions: {},
    deadline: Date.now() + 60_000,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "ghost-binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
  };
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "stale-token"]);
  const receipt = nextFrame(
    socket,
    (frame) => frame.type === "receipt" && frame.inputId === "stale-entity-answer",
  );
  socket.send(
    JSON.stringify({
      type: "request_answer",
      inputId: "stale-entity-answer",
      request,
      decision: "approve",
      credential: "stale-token",
    }),
  );
  expect(await bounded(receipt)).toMatchObject({
    inputId: "stale-entity-answer",
    result: { status: "blocked_pre", reasonCode: "request_answer.rejected" },
  });
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
    if (event.kind === "alarm") fired.resolve();
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

test("a terminal watch to an unknown machine is refused at create and its chains are retired", async () => {
  let calls = 0;
  const app = await suite.boot({
    config: suite.config("index-watch-refused-db-", { wsToken: "index-refused-token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) =>
        Effect.sync(() => {
          calls += 1;
          if (calls === 1)
            requestToolStep(input, sink, {
              id: "terminal-watch-refused",
              tool: "monitor",
              input: {
                operation: {
                  op: "create",
                  description: "ghost terminal",
                  source: { kind: "terminal", machine: "m-ghost", session: "qa", timeout_ms: 60_000 },
                },
              },
            });
          else sink.onMessage(assistantMessage(input, { text: "refused" }));
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const sealed = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const snapshot = plane.openKernel(event.sessionId).getSnapshot(event.sessionId);
    if (snapshot.turns.at(-1)?.terminal?.kind === "result") sealed.resolve();
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "index-refused-token"]);

  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "watch the ghost terminal" }));

  await bounded(sealed.promise);
  expect(calls).toBe(2);
  const session = plane.listSessions().find((row) => row.id !== "gateway-ingress");
  if (session === undefined) throw new Error("no resident session");
  // Both chains (main + timeout) were armed, failed to subscribe, and retired:
  // every latest arm is `at: null` with the install-refusal reason.
  const chains = [...foldAlarmChains(plane.openKernel(session.id), session.id).values()];
  expect(chains).toHaveLength(2);
  for (const chain of chains) {
    expect(chain.latest.at).toBeNull();
    expect(chain.armCount).toBe(2);
  }
  const main = chains.find((chain) => !chain.alarmId.endsWith(":timeout"));
  if (main === undefined) throw new Error("no main watch chain");
  expect(watchStateOf(main, session.id)).toMatchObject({ kind: "watch", status: "cancelled", fireAt: null });
});

test("boot rescan wakes armed idle sessions and skips ghost catalog rows and native chains", async () => {
  const config = suite.config("index-rescan-db-", { wsToken: "index-rescan-token" });
  const app1 = await suite.boot({
    config,
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const plane1 = await planeOf(app1.runtime);
  const sessionId = "rescan-seed";
  const kernel = plane1.openKernel(sessionId);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: `${sessionId}:materialize`,
      at: 1,
    }),
  );
  plane1.catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
  const fence = await runEffect(adoptTestFence(kernel, sessionId, "rescan-seeder"));
  // One scheduled chain with an unregistered purpose (folds to fired{stale})
  // and one native monitor.hit chain (never resent by the boot rescan).
  const due = Core.armAction({
    parentId: `${sessionId}:materialize`,
    sessionId,
    purpose: "note.due",
    at: 1_000,
    supersedes: null,
    alarmId: "due-1",
    sourceKey: "note",
    payload: {},
    armSeq: 1,
    ts: 2,
  });
  const native = Core.armAction({
    parentId: due.action.id,
    sessionId,
    purpose: Bundle.MONITOR_HIT,
    at: 2_000,
    supersedes: null,
    alarmId: "native-1",
    sourceKey: Bundle.MONITOR_SOURCE,
    payload: { spec: { watch: { command: "true", description: "native", persistent: true }, policyGeneration: 1, notificationLimit: 8 }, notifications: 0 },
    armSeq: 2,
    ts: 3,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "rescan-seeder",
      fence,
      now: 3,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [due.action, native.action],
      state: "idle",
    }),
  );
  // A catalog row without a session file: the boot mtime probe must fall back.
  plane1.catalog.indexSession({ id: "rescan-ghost", parentId: null, role: "resident", createdAt: 1 });
  await app1.stop();

  const staleFolded = Promise.withResolvers<void>();
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === sessionId && event.kind === "alarm") staleFolded.resolve();
  });
  suite.defer(unsubscribe);
  // Same catalog and sessions dir, fresh machine socket: a real reboot.
  const app2 = await suite.boot({
    config: { ...config, machines: testMachinesPlane() },
    llm: { resolveModel: fakeProviderModel, run: () => Effect.succeed({ type: "stop" as const }) },
  });
  const plane2 = await planeOf(app2.runtime);
  await bounded(staleFolded.promise);
  const kernel2 = plane2.openKernel(sessionId);
  // The resent occurrence folded to a recorded stale fact (purpose unregistered).
  expect(kernel2.actionById(`${due.occurrenceId}:stale`)?.kind).toBe("alarm");
  expect(kernel2.actionById(`${due.occurrenceId}:delivered`)).toBeUndefined();
  // The native chain was never resent: no fired fact exists for its occurrence.
  expect(kernel2.actionById(`${native.occurrenceId}:stale`)).toBeUndefined();
  expect(kernel2.actionById(`${native.occurrenceId}:delivered`)).toBeUndefined();
});

/** An idle-armed seed session: one scheduled `note.due` chain, fence rotated once. */
async function seedArmedSession(plane: Awaited<ReturnType<typeof planeOf>>, sessionId: string) {
  const kernel = plane.openKernel(sessionId);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: `${sessionId}:materialize`,
      at: 1,
    }),
  );
  plane.catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
  const fence = await runEffect(adoptTestFence(kernel, sessionId, "fault-seeder"));
  const due = Core.armAction({
    parentId: `${sessionId}:materialize`,
    sessionId,
    purpose: "note.due",
    at: 1_000,
    supersedes: null,
    alarmId: `${sessionId}-due`,
    sourceKey: "note",
    payload: {},
    armSeq: 1,
    ts: 2,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "fault-seeder",
      fence,
      now: 3,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [due.action],
      state: "idle",
    }),
  );
  return due;
}

const stopLlm = {
  resolveModel: fakeProviderModel,
  run: () => Effect.succeed({ type: "stop" as const }),
};

test("refused alarm sends (sqlite trigger fault) fail one session's rescan and another's activation resend without touching their armed rows", async () => {
  const config = suite.config("index-resend-fault-db-", { wsToken: "index-fault-token" });
  if (config.catalogPath === undefined) throw new Error("missing test catalog");
  const app1 = await suite.boot({ config, llm: stopLlm });
  const plane1 = await planeOf(app1.runtime);
  const ok = await seedArmedSession(plane1, "fault-ok");
  const rescanDue = await seedArmedSession(plane1, "fault-rescan");
  const resendDue = await seedArmedSession(plane1, "fault-resend");
  await app1.stop();

  // Fault injection at the cluster mailbox: the boot `rescan` envelope for one
  // session and the activation's armed `note.due` resend for another are
  // refused at the insert, so each awaited send fails with a real error.
  const catalog = new Database(config.catalogPath);
  catalog.exec(
    "CREATE TRIGGER refuse_rescan_send BEFORE INSERT ON cluster_messages WHEN NEW.tag = 'Alarm' AND NEW.entity_id = 'fault-rescan' BEGIN SELECT RAISE(ABORT, 'injected rescan send refusal'); END",
  );
  catalog.exec(
    "CREATE TRIGGER refuse_resend BEFORE INSERT ON cluster_messages WHEN NEW.tag = 'Alarm' AND NEW.entity_id = 'fault-resend' AND NEW.payload LIKE '%\"purpose\":\"note.due\"%' BEGIN SELECT RAISE(ABORT, 'injected resend refusal'); END",
  );
  catalog.close();

  const okStale = Promise.withResolvers<void>();
  const rescanLogged = Promise.withResolvers<void>();
  const resendLogged = Promise.withResolvers<void>();
  const errors = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("fault-rescan")) rescanLogged.resolve();
    if (line.includes("fault-resend")) resendLogged.resolve();
  });
  suite.defer(() => errors.mockRestore());
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.sessionId === "fault-ok" && event.kind === "alarm") okStale.resolve();
  });
  suite.defer(unsubscribe);
  const app2 = await suite.boot({ config: { ...config, machines: testMachinesPlane() }, llm: stopLlm });
  const plane2 = await planeOf(app2.runtime);
  await bounded(Promise.all([okStale.promise, rescanLogged.promise, resendLogged.promise]));

  // The healthy session folded its due chain stale as usual.
  expect(plane2.openKernel("fault-ok").actionById(`${ok.occurrenceId}:stale`)?.kind).toBe("alarm");
  // Refused rescan send: boot completed, the session was never activated and
  // its armed row stands with no fired fact.
  const rescanKernel = plane2.openKernel("fault-rescan");
  expect(rescanKernel.actionById(rescanDue.action.id)).toBeDefined();
  expect(rescanKernel.actionById(`${rescanDue.occurrenceId}:stale`)).toBeUndefined();
  expect(rescanKernel.actionById(`${rescanDue.occurrenceId}:delivered`)).toBeUndefined();
  // Refused activation resend: the entity came up, the resend failed, nothing
  // was retired and no fired fact was recorded — the chain stays armed.
  const resendKernel = plane2.openKernel("fault-resend");
  expect(resendKernel.actionById(resendDue.action.id)).toBeDefined();
  expect(resendKernel.actionById(`${resendDue.occurrenceId}:stale`)).toBeUndefined();
  expect(resendKernel.actionById(`${resendDue.occurrenceId}:delivered`)).toBeUndefined();
  // Secondary: each injected fault surfaced exactly one failure report.
  const lines = errors.mock.calls.map((call) => call.map(String).join(" "));
  expect(lines.filter((line) => line.includes("fault-rescan"))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("fault-resend"))).toHaveLength(1);
});
