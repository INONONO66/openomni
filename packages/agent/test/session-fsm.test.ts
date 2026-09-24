import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, PlainObjectSchema, type Inbox, type LedgerAction, type LedgerSession, type SessionTransition } from "@openomni/protocol";
import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { decideSessionAdmission } from "../src/session-admission";
import { decideRequestTransition } from "../src/session-request";
import { session, wakeSession } from "../src/session-handle";
import { turnIntentAction, turnTerminalAction } from "../src/session-record";
import type { SessionRunner, SessionRunnerInput } from "../src/session-contract";
import { createExecutor } from "../src/executor";
import { CommitFailed } from "../src/errors";
import { createSessionChatRunner } from "../src/session-chat-runner";
import { prepareChatFixture } from "./helpers/chat-services";
import { assistantStep } from "./helpers/dispatching-runner";
import { isolated } from "./helpers/isolated";
import { nth } from "./helpers/nth";
import { allowConfigure, withSessionServices, type SessionFixture } from "./helpers/session-services";
import { openRequest } from "./helpers/open-request";
import { seedPolicy } from "./helpers/seed-policy";
import { answerThenCompact } from "./helpers/effect-g2";

const row: LedgerSession.Row = {
  id: "S", parentId: null, role: "resident", leaseOwner: "owner", leaseFence: 1,
  leaseExpiresAt: 1000, revision: 1, state: "running", toolsGeneration: 1,
  systemHash: "system", policyGeneration: 1,
};
const generation = SessionHandleStore.generationSnapshot({
  generation: 1, revertTo: 0, tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1,
});
function node(action: LedgerAction.Append): LedgerAction.Node {
  return { ...action, ordinal: 1, prevHash: "prev", actionHash: "hash" };
}
const turn = node(turnIntentAction({
  id: "T", parentId: null, sessionId: "S", resultId: "R", inboxIds: [], generation,
  resumeCount: 0, boundaryActionId: null, at: 1,
}));
const open: SessionHandleStore.OpenTurn = {
  turnId: "T", resultId: "R", resumeCount: 0, boundaryActionId: null, action: turn,
  toolsGeneration: 1, toolsHash: generation.toolsHash, systemHash: generation.systemHash, policyGeneration: 1,
};
function terminal(kind: "result" | "interrupted") {
  const action = node(turnTerminalAction({
    id: "R", parentId: "T", sessionId: "S", turnId: "T", result: { kind, text: "" },
    resumeCount: 0, boundaryActionId: null, at: 2,
  }));
  const effect = SessionHandleStore.turnTerminal(action);
  if (effect === undefined) throw new Error("invalid terminal fixture");
  return { action, effect };
}
function inbox(kind: Inbox.Kind, ordinal = 1): Inbox.Row {
  return {
    id: `I${ordinal}`, sessionId: "S", kind, content: kind, ordinal, createdAt: ordinal,
    status: "pending", consumedBy: null, consumedAt: null, origin: { encodingVersion: 1, value: { kind: "session", id: "S" } },
  };
}
const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.timeout("2 seconds"));
function fixture(): SessionFixture {
  let sequence = 0;
  return {
    authorizeConfigure: allowConfigure,
    observations: { publish: () => undefined, subscribe: () => () => undefined },
    clock: () => 20, entropy: () => `fsm-${++sequence}`, processId: "fsm",
    scheduleHeartbeat: () => () => undefined,
  };
}
function declare(runtime: SessionFixture, runner: SessionRunner, id = "S") {
  return withSessionServices(session({ id, role: "resident", runner }, runtime), runtime);
}

// The table is the controller's production decision, not a test-only substitute FSM.
describe("T02/T05/T07/T08/T10 admission Cartesian product", () => {
  const states = ["idle", "running", "interrupted"] as const;
  const events = ["prompt", "interrupt", "resume"] as const;
  const terminals = [undefined, terminal("result"), terminal("interrupted")];
  const expected = {
    idle: { prompt: "start", interrupt: "consume", resume: "consume" },
    running: { prompt: "refused", interrupt: "refused", resume: "refused" },
    interrupted: { prompt: "stop", interrupt: "stop", resume: "consume" },
  } as const;
  for (const state of states) for (const event of events) for (const hasOpen of [false, true]) {
    test(`${state} x ${event} x open=${hasOpen}: all terminal and identity products`, () => {
      for (const prior of terminals) {
        const snapshot = { row: { ...row, state }, pending: [inbox(event)], open: hasOpen ? open : undefined, terminal: prior };
        let kind: ReturnType<typeof decideSessionAdmission>["kind"] = expected[state][event];
        if (hasOpen) kind = state === "idle" ? "refused" : "recover";
        else if (state === "interrupted" && event === "resume" && prior?.effect.kind === "interrupted") kind = "resume";
        expect(decideSessionAdmission(snapshot).kind).toBe(kind);
        expect(decideSessionAdmission({ ...snapshot, pending: [{ ...inbox(event), sessionId: "foreign" }] }).kind).toBe("refused");
        expect(decideSessionAdmission({ ...snapshot, pending: [{ ...inbox(event), status: "consumed" }] }).kind).toBe("refused");
        expect(decideSessionAdmission({ ...snapshot, open: { ...open, action: { ...turn, sessionId: "foreign" } } }).kind).toBe("refused");
        const foreign = terminal("interrupted");
        expect(decideSessionAdmission({ ...snapshot, terminal: { ...foreign, action: { ...foreign.action, sessionId: "foreign" } } }).kind).toBe("refused");
      }
    });
  }
  test("empty inbox and control prefix have explicit decisions without consuming a following prompt", () => {
    expect(decideSessionAdmission({ row: { ...row, state: "idle" }, pending: [] })).toEqual({ kind: "stop" });
    const control = inbox("resume");
    expect(decideSessionAdmission({ row: { ...row, state: "idle" }, pending: [control, inbox("prompt", 2)] }))
      .toEqual({ kind: "consume", items: [control] });
    expect(decideSessionAdmission({ row, pending: [] }).kind).toBe("refused");
  });
});

const request = openRequest({ requestId: "Q", sessionId: "S", turnId: "T", callId: "call" });
const invocation = node({
  id: "Q", sessionId: "S", parentId: "T", kind: "tool", ts: 1, irreversible: true,
  intent: { encodingVersion: 1, value: { phase: "intent", value: request.parsedInput, effectHash: request.effectHash } },
  effect: { encodingVersion: 1, value: { phase: "pending" } },
});
function answer(): SessionTransition.Answer {
  return {
    inputId: "input", requestId: "Q", sessionId: "S", receivedAt: 20,
    principal: { kind: "owner", principalId: "owner", evidenceId: "credential" },
    bindingDigest: request.bindingDigest, inputHash: request.inputHash, effectHash: request.effectHash,
    generation: 1, toolsHash: request.toolsHash, domainRevisions: {}, decision: "approve",
    allowedAction: "report_result", content: "",
  };
}
const payloads: readonly SessionTransition.Payload[] = [
  { kind: "request.open", request },
  { kind: "request.answer", answer: answer() },
  { kind: "request.cancel", requestId: "Q", principal: answer().principal },
  { kind: "request.timeout", requestId: "Q" },
  { kind: "request.delivery", receipt: { inputId: "input", requestId: "Q", sessionId: "S", sourceActionId: "Q", value: "accepted", at: 20 } },
];
function command(payload: SessionTransition.Payload): SessionTransition.Command {
  return { version: 1, sessionId: "S", inputId: "input", at: 20, expectedRevision: 1, authority: { owner: "owner", fence: 1 }, payload };
}
const outcomes = { open: null, resolved: "answered", refused: "denied", expired: "outcome_unknown", cancelled: "cancelled" } as const;

describe("T12/T13 request source x event x authority product", () => {
  for (const state of [undefined, "open", "resolved", "refused", "expired", "cancelled"] as const) {
    for (const payload of payloads) test(`${state ?? "absent"} x ${payload.kind}`, () => {
      const snapshot = { row, invocation, request: state === undefined ? undefined : { ...request, state, outcome: outcomes[state] } };
      const valid = command(payload);
      const result = decideRequestTransition(valid, snapshot);
      const permitted: Record<SessionTransition.Payload["kind"], SessionTransition.Resolution> = {
        "request.open": state === undefined ? "opened" : "rejected",
        "request.answer": state === "open" ? "resolved" : "duplicate",
        "request.cancel": state === "open" ? "cancelled" : "duplicate",
        "request.timeout": state === "open" ? "rejected" : "duplicate",
        "request.delivery": "delivery_recorded",
      };
      expect(result.resolution).toBe(state === undefined && payload.kind !== "request.open" ? "rejected" : permitted[payload.kind]);
      const invalid = [
        { ...valid, sessionId: "foreign" }, { ...valid, expectedRevision: 0 },
        { ...valid, authority: { owner: "foreign", fence: 1 } },
        { ...valid, authority: { owner: "owner", fence: 2 } }, { ...valid, at: 1000 },
      ];
      for (const contender of invalid) expect(decideRequestTransition(contender, snapshot)).toEqual({ resolution: "rejected", actions: [] });
      expect(decideRequestTransition(valid, { ...snapshot, row: { ...row, leaseExpiresAt: null } })).toEqual({ resolution: "rejected", actions: [] });
    });
  }
  test("T12 exact invocation, delivery input and replay record identities cannot be substituted", () => {
    expect(decideRequestTransition(command(nth(payloads, 0)), { row, invocation: { ...invocation, id: "other" } })).toEqual({ resolution: "rejected", actions: [] });
    const delivery = nth(payloads, 4);
    expect(decideRequestTransition({ ...command(delivery), inputId: "other" }, { row, request })).toEqual({ resolution: "rejected", actions: [] });
    const input = command({ kind: "request.answer", answer: answer() });
    const resolved = decideRequestTransition(input, { row, request });
    const recorded = node(nth(resolved.actions, 0));
    const snapshot = { row, request: resolved.request, inputRecord: recorded };
    expect(decideRequestTransition(input, snapshot)).toMatchObject({ resolution: "resolved", actions: [] });
    for (const altered of [
      { ...recorded, sessionId: "foreign" }, { ...recorded, parentId: "other" }, { ...recorded, id: "other" },
      { ...recorded, intent: { encodingVersion: 1 as const, value: { ...PlainObjectSchema.parse(recorded.intent.value), inputId: "other" } } },
    ]) expect(decideRequestTransition(input, { ...snapshot, inputRecord: altered })).toEqual({ resolution: "rejected", actions: [] });
  });
  test("T13 captured commit time at the deadline wins over a backdated answer", () => {
    const result = decideRequestTransition({ ...command({ kind: "request.answer", answer: answer() }), at: request.deadline }, { row, request });
    expect(result.resolution).toBe("late_unknown");
    expect(result.receive).toBeUndefined();
    expect(result.request?.state).toBe("expired");
    expect(result.actions.map((action) => action.ts)).toEqual([request.deadline, request.deadline]);
  });
});

describe("T01-T15 real controller transition witnesses", () => {
  test("T01 stable identity is recorded once; conflicting durable redeclaration enters no body", () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    let bodies = 0;
    const runner: SessionRunner = () => Effect.sync(() => { bodies += 1; return { kind: "result", text: "" }; });
    const handle = yield* declare(runtime, runner);
    expect(yield* declare(runtime, runner)).toBe(handle);
    const before = sessionTree("S");
    const other = fixture();
    const conflict = yield* Effect.exit(withSessionServices(session({ id: "S", role: "worker", parentId: "parent", runner }, other), other));
    expect(conflict._tag).toBe("Failure");
    expect(sessionTree("S")).toEqual(before);
    expect(before.map((action) => action.kind)).toEqual(["session.configure"]);
    expect(bodies).toBe(0);
  })));

  test("T02/T05/T07 intent and result ID precede entry; idle controls and running resume enter no extra runner", () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const entered = yield* Deferred.make<SessionRunnerInput>();
    const release = yield* Deferred.make<void>();
    let bodies = 0;
    const handle = yield* declare(runtime, (input) => Effect.gen(function* () {
      bodies += 1;
      expect(SessionHandleStore.latestOpenTurn("S")).toMatchObject({ turnId: input.turnId, resultId: input.resultId });
      expect(SessionHandleStore.pendingInbox("S")).toEqual([]);
      yield* Deferred.succeed(entered, input);
      yield* Deferred.await(release);
      return { kind: "result", text: "done" };
    }));
    yield* handle.interrupt();
    yield* handle.resume();
    expect(bodies).toBe(0);
    const running = yield* Effect.forkScoped(handle.prompt("start"));
    const input = yield* bounded(Deferred.await(entered));
    yield* handle.resume();
    expect(bodies).toBe(1);
    yield* Deferred.succeed(release, undefined);
    yield* bounded(Fiber.join(running));
    expect(SessionHandleStore.latestTurnTerminal("S")?.action.id).toBe(input.resultId);
    expect(SessionHandleStore.pendingInbox("S")).toEqual([]);
  })));

  for (const boundary of ["before_llm", "after_llm", "after_tools"] as const) {
    test(`T03/T04 ordered distinct prompts drain only at ${boundary} with unchanged pins`, () => isolated(Effect.gen(function* () {
      seedPolicy();
      const runtime = fixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained: string[][] = [];
      const handle = yield* declare(runtime, (input) => Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        const pins = [input.turnId, input.resultId, input.toolsHash, input.systemHash];
        const batch = yield* input.boundary(boundary);
        drained.push(batch.messages.map((message) => message.text));
        expect(batch.interrupted).toBe(false);
        expect([input.turnId, input.resultId, input.toolsHash, input.systemHash]).toEqual(pins);
        return { kind: "result", text: "done" };
      }));
      const running = yield* Effect.forkScoped(handle.prompt("start"));
      yield* bounded(Deferred.await(entered));
      // Durable ingress is independent of the runner, including compaction/approval waits.
      for (const [ordinal, content] of ["one", "two"].entries()) yield* SessionHandleStore.commitInbox({
        id: `queued-${ordinal}`, sessionId: "S", kind: "prompt", content, createdAt: 21 + ordinal,
        origin: { encodingVersion: 1, value: {} }, parentActionId: SessionHandleStore.latestAction("S")?.id ?? null,
      });
      expect(SessionHandleStore.pendingInbox("S").map((item) => item.content)).toEqual(["one", "two"]);
      expect(drained).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* bounded(Fiber.join(running));
      expect(drained).toEqual([["one", "two"]]);
      expect(SessionHandleStore.inboxRows("S").map((item) => item.status)).toEqual(["consumed", "consumed", "consumed"]);
    })));
  }

  test("T06/T08 interruption fixes its terminal; settled resume branches with fresh IDs and current G", () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const entered = yield* Deferred.make<SessionRunnerInput>();
    const inputs: SessionRunnerInput[] = [];
    const handle = yield* declare(runtime, (input) => Effect.gen(function* () {
      inputs.push(input);
      if (inputs.length === 1) {
        yield* Deferred.succeed(entered, input);
        return yield* Effect.never;
      }
      return { kind: "result", text: "resumed" };
    }));
    const running = yield* Effect.forkScoped(handle.prompt("start"));
    const first = yield* bounded(Deferred.await(entered));
    yield* bounded(handle.interrupt());
    yield* bounded(Fiber.join(running));
    const fixed = SessionHandleStore.latestTurnTerminal("S");
    expect(fixed?.action.id).toBe(first.resultId);
    expect(fixed?.effect.kind).toBe("interrupted");
    yield* handle.system.blocks.set([{ id: "new", source: "test", content: "new" }]);
    yield* handle.resume();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.turnId).not.toBe(first.turnId);
    expect(inputs[1]?.resultId).not.toBe(first.resultId);
    expect(inputs[1]?.toolsGeneration).toBe(2);
    expect(SessionHandleStore.actionById(first.resultId)).toEqual(fixed?.action);
  })));

  for (const kind of ["result", "error"] as const) test(`T09 ${kind} seals exactly one pre-minted terminal and releases its lease`, () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const handle = yield* declare(runtime, () => Effect.succeed({ kind, text: "terminal" }));
    yield* handle.prompt("start");
    const actions = sessionTree("S");
    const intent = actions.find((action) => SessionHandleStore.turnIntent(action) !== undefined);
    const endings = actions.filter((action) => SessionHandleStore.turnTerminal(action) !== undefined);
    expect(endings).toHaveLength(1);
    expect(endings[0]?.id).toBe(SessionHandleStore.turnIntent(intent)?.resultId);
    expect(SessionHandleStore.turnTerminal(endings[0])?.kind).toBe(kind);
    expect(SessionHandleStore.row("S")).toMatchObject({ state: "idle", leaseOwner: null });
  })));

  for (const source of ["current", "prior", "cancelled"] as const) test(`T09 live_wait requires a still-armed action from this turn: ${source}`, () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const alarms = Storage.get().alarms;
    if (alarms === undefined) throw new Error("missing alarms");
    const arm = () => alarms.arm({ id: "alarm", sessionId: "S", kind: "at", fireAt: 100 });
    const runner = createSessionChatRunner({ prepare: (input) => Effect.gen(function* () {
      if (source !== "prior") yield* arm().pipe(Effect.mapError((error) => new CommitFailed({ error })));
      if (source === "cancelled") yield* alarms.cancel("alarm", "S", 20).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const executor = yield* createExecutor({ ledger: input.ledger, identity: { sessionId: "S", role: "resident", parentActionId: input.turnId } });
      return prepareChatFixture({ traceContext: { traceId: "trace", sessionId: "S", runId: input.resultId }, config: {
        events: runtime.observations, executor, model: { provider: "test", id: "test" }, tools: [],
        llm: {
          resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
          run: (_request, sink) => Effect.sync(() => {
            sink.onMessage(assistantStep("", "S", ""));
            return { type: "stop" as const };
          }),
        },
      } });
    }) });
    const handle = yield* declare(runtime, runner);
    if (source === "prior") yield* arm();
    const result = yield* handle.prompt("start");
    if (source === "current") expect(result).toMatchObject({ kind: "waiting", reason: "live_wait", alarmIds: ["alarm"] });
    else expect(result?.kind).toBe("error");
    expect(SessionHandleStore.latestTurnTerminal("S")?.effect.kind).toBe(source === "current" ? "waiting" : "error");
    expect(SessionHandleStore.row("S").leaseOwner).toBeNull();
  })));

  for (const resumeCount of [0, SessionHandleStore.RESUME_BUDGET]) test(`T10 recovery budget ${resumeCount} keeps captured IDs and G`, () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    yield* SessionHandleStore.materialize({ id: "S", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: "cfg", at: 1 });
    const lease = yield* SessionHandleStore.acquireLease({ sessionId: "S", owner: "dead", expectedFence: 0, now: 1, expiresAt: 2 });
    yield* SessionHandleStore.commit({ sessionId: "S", owner: "dead", fence: lease.fence, now: 1, expectedRevision: 1, state: "running", releaseLease: false, consumeInboxIds: [], actions: [
      turnIntentAction({ id: "T", parentId: "cfg", sessionId: "S", resultId: "R", inboxIds: [], generation, resumeCount, boundaryActionId: "cfg", at: 1 }),
    ] });
    const inputs: SessionRunnerInput[] = [];
    yield* withSessionServices(wakeSession("S", (input) => Effect.sync(() => { inputs.push(input); return { kind: "result", text: "recovered" }; }), runtime), runtime);
    expect(inputs).toHaveLength(resumeCount === 0 ? 1 : 0);
    if (resumeCount === 0) expect(inputs[0]).toMatchObject({ turnId: "T", resultId: "R", toolsGeneration: 1, resumeCount: 1 });
    expect(SessionHandleStore.latestTurnTerminal("S")?.action.id).toBe("R");
    expect(SessionHandleStore.latestTurnTerminal("S")?.effect.kind).toBe(resumeCount === 0 ? "result" : "error");
  })));

  test("T14 in-flight pins stay fixed and the next turn captures the appended generation", () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const inputs: SessionRunnerInput[] = [];
    const handle = yield* declare(runtime, (input) => Effect.gen(function* () {
      inputs.push(input);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return { kind: "result", text: "done" };
    }));
    const running = yield* Effect.forkScoped(handle.prompt("first"));
    yield* bounded(Deferred.await(entered));
    const selected = yield* handle.system.blocks.set([{ id: "block", source: "test", content: "v2" }]);
    expect(selected).toEqual({ generation: 2, revertTo: 1 });
    expect(inputs[0]?.toolsGeneration).toBe(1);
    yield* Deferred.succeed(release, undefined);
    yield* bounded(Fiber.join(running));
    yield* handle.prompt("second");
    expect(inputs[1]?.toolsGeneration).toBe(2);
    expect(inputs[1]?.systemHash).not.toBe(inputs[0]?.systemHash);
  })));

  test("T15 restoration appends a branch, preserves original facts and refuses missing sources", () => isolated(Effect.gen(function* () {
    seedPolicy();
    const runtime = fixture();
    const handle = yield* declare(runtime, (input) => Effect.gen(function* () {
      const executor = yield* createExecutor({ ledger: input.ledger, identity: { sessionId: "S", role: "resident", parentActionId: input.turnId } });
      return yield* answerThenCompact(executor, input);
    }));
    yield* handle.prompt("start");
    const before = sessionTree("S");
    const compaction = before.find((action) => action.kind === "compaction" && PlainObjectSchema.parse(action.intent.value).op === "compact");
    if (compaction === undefined) throw new Error("missing compaction");
    expect((yield* Effect.exit(handle.restoreContext("missing")))._tag).toBe("Failure");
    expect(sessionTree("S")).toEqual(before);
    const foreign = yield* declare(runtime, () => Effect.succeed({ kind: "result", text: "" }), "FOREIGN");
    const foreignBefore = sessionTree("FOREIGN");
    expect((yield* Effect.exit(foreign.restoreContext(compaction.id)))._tag).toBe("Failure");
    expect(sessionTree("FOREIGN")).toEqual(foreignBefore);
    expect(SessionHandleStore.row("FOREIGN").leaseOwner).toBeNull();
    expect((yield* handle.restoreContext(compaction.id)).terminal).toBe("executed");
    expect(sessionTree("S").slice(0, before.length)).toEqual(before);
    expect(SessionHandleStore.row("S").leaseOwner).toBeNull();
    expect(canonicalDigest(sessionTree("S"))).not.toBe(canonicalDigest(before));
  })));
});
