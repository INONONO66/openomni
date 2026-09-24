import { sessionTree } from "../../ledger/test/helpers/session-tree";
import type { ResolvedExecutorOptions } from "../src/executor-contract";
import { turnTestLayer, catalogLayer } from "./helpers/service-layers";
import { allowConfigure, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber, Scope } from "effect";
import { isolated } from "./helpers/isolated";
import { describe, expect, test } from "bun:test";
import { runChatAttempts, answerThenCompact, nullRetryAlarm } from "./helpers/effect-g2";
import { OutcomeUnknown, CommitFailed } from "../src/errors";
import { seedPolicy } from "./helpers/seed-policy";
import { approveWriteRow } from "./helpers/compiled-policy";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { LlmRunFailure, type Run } from "@openomni/llm";
import { Alarm, L0Observation, type PolicyRow, type SessionHistory } from "@openomni/protocol";
import { Bus, closeSessions, createTurnDispatcher, wakeSession, type SessionRunner } from "../src/index";
import { foldSessionHistory } from "../src/session-lifecycle/history";
import { session } from "../src/session-handle";

const SECRET = "sk-live-credential-never-shown";
let nextId = 0;
let bodies = 0;
let scope: Scope.Scope;
const runtime: SessionRuntime = {
  authorizeConfigure: allowConfigure,
  observations: Bus,
  clock: () => 1_000,
  entropy: () => `inspect-id-${++nextId}`,
  processId: "inspection-test",
  scheduleHeartbeat: () => () => undefined,
  retryAlarm: nullRetryAlarm,
  authorizeApproval: () =>
    Effect.sync(() => {
      return { kind: "owner", principalId: "owner", evidenceId: "auth-1" };
    }),
  dispatchOutbound({ message }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) {
    return Effect.gen(function* () {
      const received = yield* SessionHandleStore.commitReceivedMessage({
        id: message.messageId,
        sessionId: message.destinationSessionId,
        kind: "prompt",
        content: message.content,
        origin: { encodingVersion: 1, value: message },
        createdAt: 1_000,
        parentActionId: null,
      }).pipe(
        Effect.mapError(
          (error: import("@openomni/ledger").LedgerError) => new CommitFailed({ error }),
        ),
      );
      yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(wakeSession(message.destinationSessionId, parentRunner, fixture), fixture); }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.orDie,
      );
      return received.receipt;
    });
  },
};

const rows: readonly Omit<PolicyRow.Row, "generation">[] = [
  {
    name: "refuse-forbidden",
    kind: "tool",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "forbidden" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "not_allowed" } },
    priority: 1,
  },
  approveWriteRow,
];

function providerFailure(): Run.Failure {
  return new LlmRunFailure({
    message: "overloaded",
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
    usage: {
      inputTokens: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    isRetryable: true,
    statusCode: 529,
    cause: "Error: overloaded",
  });
}

/** Waits for the next committed action of `kind` in `sessionId`, subscribed before the trigger. */
function committed(sessionId: string, kind: string): Promise<L0Observation.ActionCommitted> {
  return new Promise((resolve: (event: L0Observation.ActionCommitted) => void) => {
    const stop = Bus.subscribe(
      L0Observation.ActionCommittedEvent,
      (event: L0Observation.ActionCommitted) => {
        if (event.kind !== kind) return;
        stop();
        resolve(event);
      },
      { match: { sessionId } },
    );
  });
}

/**
 * One real turn: a retried model call, a refused tool, an approved tool carrying a
 * credential, an effect whose outcome is unknown, an answer, and a compaction.
 */
const parentRunner: SessionRunner = (input: import("../src/session-handle").SessionRunnerInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (input.messages.at(-1)?.text !== "hello") return { kind: "result", text: "noted" };
      const { executor } = (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = input; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
      let calls = 0;
      yield* runChatAttempts(executor, () =>
        Effect.gen(function* () {
          calls += 1;
          bodies += 1;
          if (calls === 1) return yield* Effect.fail(providerFailure());
          return { type: "stop" };
        }),
      );
      const opened = committed(input.sessionId, "request");
      const wave = yield* Effect.forkScoped(
        executor.runBatch(
          [
            {
              request: {
                kind: "tool",
                op: "forbidden",
                intent: { path: "/etc/shadow" },
                effect: { category: "mutation" },
                toolObservation: { turnId: input.turnId, callId: "call-forbidden" },
              },
              body() {
                return Effect.sync(() => {
                  bodies += 1;
                  return {};
                });
              },
            },
            {
              request: {
                kind: "tool",
                op: "write",
                intent: { path: "approved.txt", apiKey: SECRET },
                effect: { category: "mutation" },
                toolObservation: { turnId: input.turnId, callId: "call-write" },
              },
              body() {
                return Effect.sync(() => {
                  bodies += 1;
                  return { status: "success" };
                });
              },
            },
          ],
          { signal: new AbortController().signal },
        ),
      );
      yield* Effect.promise(() => opened).pipe(Effect.timeout("5 seconds"), Effect.orDie);
      const approvals = executor.approvals;
      const pending = approvals?.pending()[0];
      if (approvals === undefined || pending === undefined)
        throw new Error("approval never opened");
      yield* approvals.answer({ request: pending, credential: "owner", decision: "approve" });
      yield* Fiber.join(wave);
      const [unknown] = yield* executor.runBatch(
        [
          {
            request: {
              kind: "tool",
              op: "webhook",
              intent: { url: "https://example.test" },
              effect: { category: "mutation" },
              toolObservation: { turnId: input.turnId, callId: "call-webhook" },
            },
            body() {
              return Effect.gen(function* () {
                bodies += 1;
                return yield* new OutcomeUnknown({ reason: "webhook_unconfirmed" });
              });
            },
          },
        ],
        { signal: new AbortController().signal },
      );
      if (unknown?.terminal !== "outcome_unknown")
        throw new Error("webhook settlement must be uncertain");
      return yield* answerThenCompact(executor, input);
    }),
  );

/** Parent turn, commissioned child whose answer wakes the parent, then a monitor wake. */
function lifecycle() {
  return Effect.gen(function* () {
    Bus.reset();
    nextId = 0;
    bodies = 0;
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
    seedPolicy(rows);
    scope = yield* Effect.scope;
    yield* Effect.addFinalizer(() =>
      closeSessions(runtime).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => Bus.reset()))),
    );
    const parent = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "parent", role: "resident", runner: parentRunner }, fixture), fixture); });
    yield* parent.prompt("hello");
    const child = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
        id: "child",
        parentId: "parent",
        role: "worker",
        runner: () =>
          Effect.sync(() => {
            return { kind: "result", text: "child answer" };
          }),
      }, fixture), fixture); });
    const commission = sessionTree("parent").find(
      (action: import("@openomni/protocol").LedgerAction.Node) =>
        SessionHandleStore.turnTerminal(action) !== undefined,
    );
    if (commission === undefined) throw new Error("parent turn never sealed");
    yield* child.prompt("work", {
      encodingVersion: 1,
      value: {
        kind: "message",
        messageId: "commission",
        senderSessionId: "parent",
        sourceActionId: commission.id,
      },
    });
    const alarms = Storage.get().alarms;
    if (alarms === undefined) throw new Error("missing alarm adapter");
    yield* alarms.arm({ id: "monitor", sessionId: "parent", kind: "at", fireAt: 1_000 });
    const owned = yield* alarms.acquire("monitor", 0);
    if (owned === undefined) throw new Error("alarm acquisition refused");
    const woke = committed("parent", "turn");
    yield* alarms.fire({
      id: "monitor",
      epoch: 1,
      fence: owned.fence,
      sourceKey: `timer:${owned.fireAt}`,
      at: 1_000,
      content: "monitor woke",
      terminal: true,
    });
    yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(wakeSession("parent", parentRunner, fixture), fixture); });
    yield* Effect.promise(() => woke).pipe(Effect.timeout("5 seconds"));
    return parent;
  });
}

describe("action-based history and diagnostic projections", () => {
  test("every transition of a request spanning child, retry, refusal, approval, wake and compaction traces to a committed cause", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const inspection = parent.inspect({ depth: 1 });
          const tree = sessionTree("parent");
          expect(
            inspection.transitions.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.actionId,
            ),
          ).toEqual(tree.map((a: import("@openomni/protocol").LedgerAction.Node) => a.id));
          expect(
            inspection.transitions.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.revision,
            ),
          ).toEqual(
            tree.map((action: import("@openomni/protocol").LedgerAction.Node) => action.ordinal),
          );
          const known = new Set(
            tree.map((action: import("@openomni/protocol").LedgerAction.Node) => action.id),
          );
          const inbox = new Set(
            SessionHandleStore.inboxRows("parent").map(
              (row: import("@openomni/protocol").Inbox.Row) => row.id,
            ),
          );
          for (const transition of inspection.transitions) {
            switch (transition.cause.kind) {
              case "action":
                expect(known.has(transition.cause.actionId)).toBe(true);
                break;
              case "inbox":
                for (const id of transition.cause.inboxIds) expect(inbox.has(id)).toBe(true);
                break;
              case "alarm":
                expect(transition.cause).toEqual({ kind: "alarm", alarmId: "monitor", epoch: 1 });
                break;
              case "root":
                expect(transition.parentId).toBeNull();
                expect(["session.configure", "alarm.arm"]).toContain(transition.kind);
                break;
              default:
                throw new Error("unreachable cause");
            }
          }
          const byOp = (op: string, phase: SessionHistory.Phase) =>
            inspection.transitions.filter(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.op === op && entry.phase === phase,
            );
          expect(
            byOp("chat", "intent").filter(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.kind === "attempt",
            ),
          ).toHaveLength(2);
          expect(
            byOp("chat", "result").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.outcome,
            ),
          ).toEqual(["executed", "executed", "executed"]);
          const attemptResults = tree.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              action.kind === "attempt" &&
              action.effect.value !== null &&
              typeof action.effect.value === "object" &&
              !Array.isArray(action.effect.value) &&
              action.effect.value.phase === "result",
          );
          expect(attemptResults[0]?.effect.value).toMatchObject({
            evidence: { failures: [{ tag: "LlmRunFailure" }], defects: [], interrupted: false },
          });
          expect(byOp("forbidden", "intent")).toEqual([]);
          expect(
            byOp("forbidden", "decision").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => [entry.outcome, entry.reason],
            ),
          ).toEqual([["blocked_pre", "not_allowed"]]);
          expect(
            byOp("write", "result").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.outcome,
            ),
          ).toEqual(["executed"]);
          expect(
            byOp("webhook", "result").map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.outcome,
            ),
          ).toEqual(["outcome_unknown"]);
          expect(inspection.requests).toMatchObject([
            { mode: "approval", callId: "call-write", state: "resolved", outcome: "executed" },
          ]);
          expect(inspection.compactions).toHaveLength(1);
          expect(inspection.compactions[0]?.discarded.count).toBeGreaterThan(0);
          expect(inspection.compactions[0]?.restoredBy).toEqual([]);
          const woke = inspection.transitions.filter(
            (
              entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
            ) => entry.cause.kind === "alarm",
          );
          expect(
            woke.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.kind,
            ),
          ).toEqual(["alarm.fired"]);
          const monitorFire = Alarm.occurrenceId("monitor", 1, "timer:1000");
          expect(
            woke.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => entry.actionId,
            ),
          ).toEqual([monitorFire]);
          const wakePrompt = inspection.transitions.find(
            (
              entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
            ) => entry.kind === "prompt" && entry.parentId === monitorFire,
          );
          expect(wakePrompt?.cause).toEqual({ kind: "action", actionId: monitorFire });
          const fromChild = inspection.transitions.find(
            (
              entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
            ) => entry.kind === "prompt" && entry.peerSessionId === "child",
          );
          expect(
            inspection.children.map(
              (child: import("@openomni/protocol").SessionHistory.Inspection) => child.sessionId,
            ),
          ).toEqual(["child"]);
          const outbound = inspection.children[0]?.transitions.filter(
            (e: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number]) =>
              e.kind === "outbound",
          );
          expect(
            outbound?.map(
              (
                entry: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
              ) => [entry.peerSessionId, entry.outcome],
            ),
          ).toEqual([
            ["parent", "pending"],
            ["parent", "executed"],
          ]);
          const obligation = SessionHandleStore.outboundRows("child")[0];
          expect(fromChild?.actionId).toBe(obligation?.message.messageId ?? "");
          expect(fromChild?.cause).toEqual({
            kind: "inbox",
            inboxIds: [fromChild?.actionId ?? ""],
          });
          expect(inspection.children[0]?.children).toEqual([]);
          expect(parent.inspect({ depth: 0 }).children).toEqual([]);
        }),
      ),
    ));

  test("policy decisions carry generation, rule and verdict and never carry payloads", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const inspection = parent.inspect();
          expect(
            inspection.policy.filter(
              (
                decision: import("@openomni/protocol").SessionHistory.Inspection["policy"][number],
              ) => decision.verdict === "deny",
            ),
          ).toMatchObject([
            { op: "forbidden", hook: "tool.pre", matchedRuleIds: ["refuse-forbidden"] },
          ]);
          expect(
            inspection.policy.filter(
              (
                decision: import("@openomni/protocol").SessionHistory.Inspection["policy"][number],
              ) => decision.matchedRuleIds.includes("approve-write"),
            ),
          ).toMatchObject([{ verdict: "require_approval", reason: "owner", generation: 1 }]);
          expect(
            inspection.policy.every(
              (
                decision: import("@openomni/protocol").SessionHistory.Inspection["policy"][number],
              ) => decision.generation === 1,
            ),
          ).toBe(true);
          for (const decision of inspection.policy) {
            if (decision.subjectActionId === null) continue;
            expect(
              inspection.transitions.some(
                (
                  e: import("@openomni/protocol").SessionHistory.Inspection["transitions"][number],
                ) => e.actionId === decision.subjectActionId,
              ),
            ).toBe(true);
          }
          const rendered = JSON.stringify(inspection);
          expect(JSON.stringify(sessionTree("parent"))).toContain(SECRET);
          expect(rendered).not.toContain(SECRET);
          expect(rendered).not.toContain("/etc/shadow");
        }),
      ),
    ));

  test("inspection and history are pure reads: no body runs and no action is appended", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const before = sessionTree("parent");
          const ran = bodies;
          parent.inspect({ depth: 2 });
          parent.history({ limit: 5 });
          expect(bodies).toBe(ran);
          expect(sessionTree("parent")).toEqual(before);
          expect(sessionTree("child")).toEqual(sessionTree("child"));
        }),
      ),
    ));

  test("a materialized tail rebuilt from bounded pages equals the canonical fold", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* lifecycle();
          const before = sessionTree("parent");
          const rebuilt: typeof before = [];
          let page = parent.history({ afterRevision: 0, limit: 4 });
          for (;;) {
            expect(page.actions.length).toBeLessThanOrEqual(4);
            rebuilt.push(...page.actions);
            if (page.nextRevision === null) break;
            page = parent.history({ afterRevision: page.nextRevision, limit: 4 });
          }
          expect(page.headRevision).toBe(parent.get().revision);
          expect(rebuilt).toEqual(before);
          expect(parent.inspect({ depth: 0 }).children).toEqual([]);
          expect(foldSessionHistory("parent", rebuilt)).toEqual(
            foldSessionHistory("parent", before),
          );
        }),
      ),
    ));
});
