import { type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import type { Inbox, PlainValue } from "@openomni/protocol";
import { Effect } from "effect";
import { isolated } from "./helpers/isolated";
import { awaitSignal, failure, boundedSignal as bounded } from "./helpers/g0-signals";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { openRequest } from "./helpers/open-request";
import type { ExecutionApprovalRequest, ExecutionApprovals } from "../src/executor-contract";
import { closeSessions, session, type SessionCreateOptions, type SessionHandle, type SessionRunner, type SessionRunnerInput, sweepSessions } from "../src/session-handle";
import { ForeignFailure, SessionHandleStore, Storage } from "@openomni/ledger";
import {
  type BusEvent,
  type LedgerAction,
  L0Observation,
  PlainValueSchema,
  type ObservationSink,
  type SessionGeneration,
  type SessionTransition,
  type SessionTurn,
} from "@openomni/protocol";
import { CommitFailed } from "../src/errors";
import { GenerationOwnership } from "../src/services";
import { GenerationRawSlots } from "../src/session-generations";
import { Bus } from "../src/index";

interface Signal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function signal<T>(): Signal<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve: (value: T | PromiseLike<T>) => void) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** A runner that ignores abort and only settles once released; tracks its concurrency. */
function stubbornRunner(options: { readonly resumeAfterFirst?: boolean } = {}) {
  const entered = signal<void>();
  const abortSeen = signal<void>();
  const releaseRunner = signal<void>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const runner: SessionRunner = (input: SessionRunnerInput) =>
    Effect.gen(function* () {
      calls += 1;
      if (options.resumeAfterFirst && calls > 1) return { kind: "result", text: "resumed" };
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      input.signal.addEventListener("abort", () => abortSeen.resolve(), { once: true });
      const settled = releaseRunner.promise.then(() => {
        active -= 1;
      });
      input.retainEffect?.(settled);
      entered.resolve();
      yield* Effect.promise(() => settled);
      return { kind: "result", text: "late" };
    });
  return {
    runner,
    entered,
    abortSeen,
    releaseRunner,
    maximumActive: () => maximumActive,
    calls: () => calls,
  };
}

type StubbornRun = ReturnType<typeof stubbornRunner>;

/** Prompts, waits for the stubborn runner to enter, interrupts, and waits for the abort to reach it. */
function interruptStubborn(handle: SessionHandle, run: StubbornRun) {
  return Effect.gen(function* () {
    const running = yield* Effect.fork(handle.prompt("start"));
    yield* awaitSignal(bounded(run.entered.promise, "runner entry"));
    const interrupted = yield* Effect.fork(handle.interrupt());
    yield* awaitSignal(bounded(run.abortSeen.promise, "runner abort signal"));
    return { running, interrupted };
  });
}

/**
 * The caller-facing interrupt completes at the sealed terminal, not when the
 * abort-ignoring runner finally settles; the lease stays held until then.
 */
function settleStubborn(
  handle: SessionHandle,
  run: StubbornRun,
  pending: Effect.Effect.Success<ReturnType<typeof interruptStubborn>>,
  hibernated: Signal<void>,
) {
  return Effect.gen(function* () {
    yield* awaitSignal(bounded(pending.interrupted, "interrupt receipt before runner settlement"));
    expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
    run.releaseRunner.resolve();
    yield* awaitSignal(
      bounded(
        Effect.all([awaitSignal(pending.running), awaitSignal(hibernated.promise)], {
          concurrency: "unbounded",
        }),
        "runner settlement + lease release",
      ),
    );
  });
}

/** A runner that records every input it receives and answers `text`. */
function recordingRunner(text: string): { runner: SessionRunner; inputs: SessionRunnerInput[] } {
  const inputs: SessionRunnerInput[] = [];
  const runner: SessionRunner = (input: SessionRunnerInput) =>
    Effect.sync(() => {
      inputs.push(input);
      return { kind: "result", text };
    });
  return { runner, inputs };
}

/** No second runtime may take the lease while the stubborn runner lives; once it settles the lease is free. */
function expectLeaseHeldUntilSettled(
  handle: SessionHandle,
  run: StubbornRun,
  pending: Effect.Effect.Success<ReturnType<typeof interruptStubborn>>,
  hibernated: Signal<void>,
  fence: number = handle.get().lease.fence,
) {
  return Effect.gen(function* () {
    expect(yield* failure(contendLease(handle, fence))).toMatchObject({
      _tag: "LeaseRefused",
      reason: "held",
    });
    expect(run.maximumActive()).toBe(1);
    yield* awaitSignal(settleStubborn(handle, run, pending, hibernated));
    expect((yield* contendLease(handle)).ok).toBe(true);
    expect(run.maximumActive()).toBe(1);
  });
}

/** Declares `id` with a runtime whose hibernation resolves the returned signal. */
function hibernatingSession(
  id: string,
  runner: SessionRunner,
  extra: Partial<SessionRuntime> = {},
) {
  return Effect.gen(function* () {
    const hibernated = signal<void>();
    const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = {
      ...runtime,
      ...extra,
      onHibernate: () => Effect.sync(() => hibernated.resolve()),
    }; return yield* withSessionServices(session(residentOptions(id, runner), fixture), fixture); });
    return { handle, hibernated };
  });
}

/** A second runtime trying to take the lease right now, without waiting for the TTL. */
function contendLease(handle: SessionHandle, expectedFence: number = handle.get().lease.fence) {
  return Effect.gen(function* () {
    return yield* SessionHandleStore.acquireLease({
      sessionId: handle.id,
      owner: "second-runtime",
      expectedFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
  });
}

class TestObservationSink implements ObservationSink {
  dropNextCommit = false;
  onCommit: ((committed: L0Observation.ActionCommitted) => void) | undefined;

  publish<T>(event: BusEvent.Descriptor<T>, data: T): void {
    if (event.name === L0Observation.ActionCommittedEvent.name) {
      if (this.dropNextCommit) {
        this.dropNextCommit = false;
        return;
      }
      this.onCommit?.(L0Observation.ActionCommittedEvent.schema.parse(data));
    }
    Bus.publish(event, data);
  }

  subscribe<T>(
    event: BusEvent.Descriptor<T>,
    handler: (data: T) => void,
    options?: { match?: Partial<T> },
  ): () => void {
    return Bus.subscribe(event, handler, options);
  }
}

const tool = (name: string): SessionGeneration.Tool => ({
  name,
  category: "query",
  inputSchema: { type: "object", properties: {} },
});

const system = {
  preset: "resident preset",
  blocks: [{ id: "rules", source: "test", content: "Stay deterministic." }],
} as const;

let now = 1_000;
let nextId = 0;
let sink: TestObservationSink;
let runtime: SessionRuntime;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  now = 1_000;
  nextId = 0;
  sink = new TestObservationSink();
  runtime = {
    observations: sink,
    clock: () => now,
    entropy: () => `session-test-id-${++nextId}`,
    processId: "session-test-process",
    scheduleHeartbeat: () => () => undefined,
  };
  Bus.reset();
});

function testProgram<A, E>(program: Effect.Effect<A, E, import("effect").Scope.Scope>) {
  return isolated(
    Effect.scoped(
      Effect.gen(function* () {
        Storage.reset();
        Storage.reset();
        Storage.initialize({ dbPath: ":memory:", observationSink: sink });
        seedPolicy();
        return yield* program.pipe(Effect.ensuring(closeSessions(runtime).pipe(Effect.orDie)));
      }),
    ),
  );
}

afterEach(() => Bus.reset());

function residentOptions(id: string, runner: SessionRunner): SessionCreateOptions {
  return { id, role: "resident", runner, tools: [tool("read")], system };
}

function policyHook(action: Pick<LedgerAction.Append, "kind" | "intent">): string | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.hook === "string" ? value.hook : undefined;
}

function policyGeneration(action: LedgerAction.Node): number | undefined {
  if (action.kind !== "policy.decision") return undefined;
  const value = action.intent.value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  return typeof value.generation === "number" ? value.generation : undefined;
}

function commitOpenTurn(input: {
  readonly sessionId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly toolsHash?: string;
}) {
  return Effect.gen(function* () {
    const created = yield* SessionHandleStore.materialize({
      id: input.sessionId,
      parentId: null,
      role: "resident",
      tools: [tool("read")],
      system,
      policyGeneration: SessionHandleStore.currentPolicyGeneration(),
      actionId: `${input.sessionId}:configure`,
      at: now,
    });
    const generation = SessionHandleStore.latestGeneration(
      SessionHandleStore.tree(input.sessionId),
    );
    const acquired = yield* SessionHandleStore.acquireLease({
      sessionId: input.sessionId,
      owner: "crashed-owner",
      expectedFence: created.row.leaseFence,
      now,
      expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    if (!acquired.ok) throw new Error("crash fixture could not acquire its lease");
    const committed = yield* SessionHandleStore.commit({
      sessionId: input.sessionId,
      owner: "crashed-owner",
      fence: acquired.fence,
      now,
      expectedRevision: created.row.revision,
      actions: [
        {
          id: `${input.sessionId}:turn`,
          parentId: SessionHandleStore.tree(input.sessionId).at(-1)?.id ?? null,
          sessionId: input.sessionId,
          kind: "turn",
          intent: {
            encodingVersion: 1,
            value: {
              phase: "intent",
              resultId: input.resultId,
              inboxIds: [],
              toolsGeneration: generation.generation,
              toolsHash: input.toolsHash ?? generation.toolsHash,
              systemHash: generation.systemHash,
              policyGeneration: generation.policyGeneration,
              resumeCount: input.resumeCount,
              boundaryActionId: null,
            },
          },
          effect: { encodingVersion: 1, value: { phase: "pending" } },
          irreversible: true,
          ts: now,
        },
      ],
      consumeInboxIds: [],
      state: "running",
      releaseLease: false,
    });
    if (!committed.ok) throw new Error("crash fixture could not commit its open turn");
    now += SessionHandleStore.LEASE_TTL_MS;
  });
}

function durableRequest(sessionId: string, turnId: string): SessionTransition.Request {
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
  return openRequest({
    requestId: `${sessionId}:request`,
    sessionId,
    turnId,
    callId: `${sessionId}:call`,
    toolsGeneration: generation.generation,
    toolsHash: generation.toolsHash,
    systemHash: generation.systemHash,
    deadline: now + 1_000,
    createdAt: now,
  });
}

function approvalRequest(sessionId: string, turnId: string): ExecutionApprovalRequest {
  const durable = durableRequest(sessionId, turnId);
  return {
    durable,
    id: durable.requestId,
    sessionId,
    turnId,
    callId: durable.callId,
    inputHash: durable.inputHash,
    generation: 1,
    revision: 1,
    policyDecisionId: `${sessionId}:decision`,
    intent: {},
  };
}

describe("durable session handle", () => {
  test("records prompt and turn policy once at their existing durable envelopes", () =>
    testProgram(
      Effect.gen(function* () {
        const observedBeforeCommit: string[] = [];
        const observedDecisionIds = new Set<string>();
        sink.onCommit = (committed: {
          id: string;
          sessionId: string;
          revision: number;
          kind:
            | "message"
            | "prompt"
            | "tool"
            | "attempt"
            | "reply"
            | "outbound"
            | "request"
            | "turn"
            | "llm"
            | "inbox.deliver"
            | "compaction"
            | "alarm.arm"
            | "alarm.fired"
            | "alarm.paused"
            | "session.configure"
            | "policy.decision";
        }) => {
          if (committed.kind !== "policy.decision") return;
          observedDecisionIds.add(committed.id);
          if (
            !SessionHandleStore.tree("policy-topology").some(
              (action: LedgerAction.Node) => action.id === committed.id,
            )
          ) {
            observedBeforeCommit.push(committed.id);
          }
        };
        const policies = Storage.get().policies;
        if (policies === undefined) throw new Error("missing policy adapter");
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            for (const row of policies.rows(1)) policies.append({ ...row, generation: 2 });
            policies.append({
              name: "deny-new-generation-turn-post",
              kind: "turn",
              phase: "post",
              match: { encodingVersion: 1, value: { op: "session" } },
              verdict: { encodingVersion: 1, value: { type: "deny", reason: "new generation" } },
              priority: 2_000,
              generation: 2,
            });
            return { kind: "result", text: "complete" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("policy-topology", runner), fixture), fixture); });

        const result = yield* awaitSignal(handle.prompt("run once"));

        const tree = SessionHandleStore.tree(handle.id);
        const prompt = tree.find((action: LedgerAction.Node) => action.kind === "prompt");
        const turn = tree.find(
          (action: LedgerAction.Node) => SessionHandleStore.turnIntent(action) !== undefined,
        );
        const decisions = tree.filter(
          (action: LedgerAction.Node) => action.kind === "policy.decision",
        );
        expect(result).toEqual({ kind: "result", text: "complete" });
        expect(tree.filter((action: LedgerAction.Node) => action.kind === "prompt")).toHaveLength(
          1,
        );
        expect(tree.filter((action: LedgerAction.Node) => action.kind === "turn")).toHaveLength(2);
        expect(decisions.map(policyHook).sort()).toEqual([
          "prompt.post",
          "prompt.pre",
          "turn.post",
          "turn.pre",
        ]);
        expect(
          decisions
            .filter((action: LedgerAction.Node) => policyHook(action)?.startsWith("prompt."))
            .every((action: LedgerAction.Node) => action.parentId === prompt?.id),
        ).toBe(true);
        expect(
          decisions
            .filter((action: LedgerAction.Node) => policyHook(action)?.startsWith("turn."))
            .every((action: LedgerAction.Node) => action.parentId === turn?.id),
        ).toBe(true);
        expect(decisions.map(policyGeneration)).toEqual([1, 1, 1, 1]);
        expect(observedDecisionIds).toEqual(
          new Set(decisions.map((action: LedgerAction.Node) => action.id)),
        );
        expect(observedBeforeCommit).toEqual([]);
      }),
    ));

  /** Runs one prompt against an isolated store whose only extra policy row denies prompts at `phase`. */
  function promptDeniedAt(phase: "pre" | "post", reason: string) {
    return Effect.gen(function* () {
      return yield* awaitSignal(
        Effect.gen(function* () {
          Storage.reset();
          Storage.initialize({ dbPath: ":memory:", observationSink: sink });
          seedPolicy([
            {
              name: `deny-prompt-${phase}`,
              kind: "prompt",
              phase,
              match: { encodingVersion: 1, value: { op: "inbox" } },
              verdict: { encodingVersion: 1, value: { type: "deny", reason } },
              priority: 2_000,
            },
          ]);
          const isolatedRuntime = { ...runtime };
          let calls = 0;
          const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(session(residentOptions(`prompt-${phase}-deny`, () =>
              Effect.sync(() => {
                calls += 1;
                return { kind: "result", text: "must not run" };
              }),
            ), fixture), fixture); });
          const result = yield* awaitSignal(handle.prompt("blocked prompt"));
          const tree = SessionHandleStore.tree(handle.id);
          expect(result).toMatchObject({
            kind: "error",
            cause: { name: "SessionPolicyRefusal", reason },
          });
          expect(calls).toBe(0);
          expect(tree.filter((action: LedgerAction.Node) => action.kind === "turn")).toEqual([]);
          const hooks = tree
            .filter((action: LedgerAction.Node) => action.kind === "policy.decision")
            .map(policyHook);
          const inbox = SessionHandleStore.inboxRows(handle.id).map((row: Inbox.Row) => row.status);
          yield* awaitSignal(closeSessions(isolatedRuntime));
          Storage.reset();
          return { hooks, inbox };
        }),
      );
    });
  }

  test("a prompt pre denial consumes the inbox row without constructing or running a turn", () =>
    testProgram(
      Effect.gen(function* () {
        const { hooks, inbox } = yield* awaitSignal(promptDeniedAt("pre", "prompt refused"));
        expect(hooks).toEqual(["prompt.pre"]);
        expect(inbox).toEqual(["consumed"]);
      }),
    ));

  test("a prompt post denial records both prompt decisions but never starts a turn", () =>
    testProgram(
      Effect.gen(function* () {
        const { hooks } = yield* awaitSignal(promptDeniedAt("post", "prompt post refused"));
        expect(hooks).toEqual(["prompt.pre", "prompt.post"]);
      }),
    ));

  test("fails closed when prompt post policy transforms its immutable receipt", () =>
    testProgram(
      Effect.gen(function* () {
        yield* awaitSignal(
          Effect.gen(function* () {
            Storage.reset();
            Storage.initialize({ dbPath: ":memory:", observationSink: sink });
            seedPolicy([
              {
                name: "transform-prompt-receipt",
                kind: "prompt",
                phase: "post",
                match: { encodingVersion: 1, value: { op: "inbox" } },
                verdict: {
                  encodingVersion: 1,
                  value: { type: "transform", name: "redact", paths: ["result.status"] },
                },
                priority: 2_000,
              },
            ]);
            const isolatedRuntime = { ...runtime };
            let calls = 0;
            const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(session(residentOptions("prompt-transform", () =>
                Effect.sync(() => {
                  calls += 1;
                  return { kind: "result", text: "must not run" };
                }),
              ), fixture), fixture); });

            const result = yield* awaitSignal(handle.prompt("immutable prompt"));

            expect(result).toMatchObject({
              kind: "error",
              cause: { name: "SessionPolicyRefusal", reason: "invalid_output" },
            });
            expect(calls).toBe(0);
            expect(
              SessionHandleStore.tree(handle.id).filter(
                (action: LedgerAction.Node) => action.kind === "turn",
              ),
            ).toEqual([]);
            yield* awaitSignal(closeSessions(isolatedRuntime));
            Storage.reset();
          }),
        );
      }),
    ));

  test("accepts a turn post transform only when the result still satisfies its contract", () =>
    testProgram(
      Effect.gen(function* () {
        for (const path of ["result.usage", "result.text"] as const) {
          yield* awaitSignal(
            Effect.gen(function* () {
              Storage.reset();
              Storage.initialize({ dbPath: ":memory:", observationSink: sink });
              seedPolicy([
                {
                  name: `transform-turn-${path}`,
                  kind: "turn",
                  phase: "post",
                  match: { encodingVersion: 1, value: { op: "session" } },
                  verdict: {
                    encodingVersion: 1,
                    value: { type: "transform", name: "redact", paths: [path] },
                  },
                  priority: 2_000,
                },
              ]);
              const isolatedRuntime = { ...runtime };
              let calls = 0;
              const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(session(residentOptions(`turn-transform-${path}`, () =>
                  Effect.sync(() => {
                    calls += 1;
                    return {
                      kind: "result",
                      text: "typed result",
                      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                    };
                  }),
                ), fixture), fixture); });

              const result = yield* awaitSignal(handle.prompt("transform turn result"));

              expect(calls).toBe(1);
              if (path === "result.usage") {
                expect(result).toEqual({ kind: "result", text: "typed result" });
              } else {
                expect(result).toMatchObject({
                  kind: "error",
                  cause: { name: "SessionPolicyRefusal", reason: "invalid_output" },
                });
              }
              yield* awaitSignal(closeSessions(isolatedRuntime));
              Storage.reset();
            }),
          );
        }
      }),
    ));

  for (const sample of [
    {
      name: "required counters",
      valid: true,
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
    },
    {
      name: "optional counters",
      valid: true,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
    },
    { name: "missing required counter", valid: false, usage: { inputTokens: 4, outputTokens: 5 } },
    {
      name: "invalid optional counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        reasoningTokens: "invalid",
      },
    },
    {
      name: "unknown counter",
      valid: false,
      usage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
        unknownTokens: 1,
      },
    },
  ] as const) {
    test(`validates transformed session usage with ${sample.name}`, () =>
      testProgram(
        Effect.gen(function* () {
          yield* awaitSignal(
            Effect.gen(function* () {
              Storage.reset();
              Storage.initialize({ dbPath: ":memory:", observationSink: sink });
              seedPolicy([
                {
                  name: "transform-usage",
                  kind: "turn",
                  phase: "post",
                  match: { encodingVersion: 1, value: { op: "session" } },
                  verdict: {
                    encodingVersion: 1,
                    value: {
                      type: "transform",
                      name: "redact",
                      paths: ["result.usage"],
                      replacement: PlainValueSchema.parse(sample.usage),
                    },
                  },
                  priority: 2_000,
                },
              ]);
              const isolatedRuntime = { ...runtime };
              try {
                const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(session(residentOptions("usage-transform", () =>
                    Effect.sync(() => {
                      return {
                        kind: "result",
                        text: "result",
                        finishReason: "stop",
                        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                      };
                    }),
                  ), fixture), fixture); });
                const result = yield* awaitSignal(
                  bounded(handle.prompt("measure"), "transformed usage terminal"),
                );
                if (sample.valid) {
                  expect(result).toEqual({
                    kind: "result",
                    text: "result",
                    finishReason: "stop",
                    usage: sample.usage,
                  });
                } else {
                  expect(result).toMatchObject({
                    kind: "error",
                    cause: { name: "SessionPolicyRefusal", reason: "invalid_output" },
                  });
                }
                expect(
                  SessionHandleStore.tree(handle.id)
                    .map(SessionHandleStore.turnTerminal)
                    .filter(
                      (
                        value:
                          | {
                              phase: "terminal";
                              turnId: string;
                              kind: "interrupted" | "error" | "result" | "waiting";
                              text: string;
                              boundaryActionId: string | null;
                              resumeCount: number;
                              reason?: "live_wait" | undefined;
                              alarmIds?: string[] | undefined;
                            }
                          | undefined,
                      ) => value !== undefined,
                    ),
                ).toMatchObject([{ kind: sample.valid ? "result" : "error" }]);
              } finally {
                yield* awaitSignal(closeSessions(isolatedRuntime));
                Storage.reset();
              }
            }),
          );
        }),
      ));
  }

  test("turn policy denial distinguishes body-zero pre from irreversible post", () =>
    testProgram(
      Effect.gen(function* () {
        for (const phase of ["pre", "post"] as const) {
          yield* awaitSignal(
            Effect.gen(function* () {
              Storage.reset();
              Storage.initialize({ dbPath: ":memory:", observationSink: sink });
              seedPolicy([
                {
                  name: `deny-turn-${phase}`,
                  kind: "turn",
                  phase,
                  match: { encodingVersion: 1, value: { op: "session" } },
                  verdict: {
                    encodingVersion: 1,
                    value: { type: "deny", reason: `turn ${phase} refused` },
                  },
                  priority: 2_000,
                },
              ]);
              const isolatedRuntime = { ...runtime };
              let calls = 0;
              const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(session(residentOptions(`turn-${phase}-deny`, () =>
                  Effect.sync(() => {
                    calls += 1;
                    return { kind: "result", text: "body result" };
                  }),
                ), fixture), fixture); });

              const result = yield* awaitSignal(handle.prompt("start the turn"));

              const tree = SessionHandleStore.tree(handle.id);
              const hooks = tree
                .filter((action: LedgerAction.Node) => action.kind === "policy.decision")
                .map(policyHook);
              expect(result).toMatchObject({
                kind: "error",
                cause: { name: "SessionPolicyRefusal", reason: `turn ${phase} refused` },
              });
              expect(calls).toBe(phase === "pre" ? 0 : 1);
              expect(hooks).toEqual(
                phase === "pre"
                  ? ["prompt.pre", "prompt.post", "turn.pre"]
                  : ["prompt.pre", "prompt.post", "turn.pre", "turn.post"],
              );
              expect(
                tree
                  .map(SessionHandleStore.turnTerminal)
                  .find(
                    (
                      terminal:
                        | {
                            phase: "terminal";
                            turnId: string;
                            kind: "interrupted" | "error" | "result" | "waiting";
                            text: string;
                            boundaryActionId: string | null;
                            resumeCount: number;
                            reason?: "live_wait" | undefined;
                            alarmIds?: string[] | undefined;
                          }
                        | undefined,
                    ) => terminal !== undefined,
                  ),
              ).toMatchObject({ kind: "error" });
              yield* awaitSignal(closeSessions(isolatedRuntime));
              Storage.reset();
            }),
          );
        }
      }),
    ));

  test("refuses a turn when its pinned generation has no mandatory policy row", () =>
    testProgram(
      Effect.gen(function* () {
        yield* awaitSignal(
          Effect.gen(function* () {
            Storage.reset();
            Storage.initialize({ dbPath: ":memory:", observationSink: sink });
            const isolatedRuntime = { ...runtime };
            let calls = 0;
            const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(session(residentOptions("missing-policy", () =>
                Effect.sync(() => {
                  calls += 1;
                  return { kind: "result", text: "ran" };
                }),
              ), fixture), fixture); });

            const result = yield* awaitSignal(handle.prompt("must be refused"));

            expect(calls).toBe(0);
            expect(result).toMatchObject({
              kind: "error",
              cause: { name: "SessionPolicyRefusal", code: "session_policy_refused" },
            });
            yield* awaitSignal(closeSessions(isolatedRuntime));
            Storage.reset();
          }),
        );
      }),
    ));

  test("serializes one runner and drains concurrent prompts as distinct ordered messages", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const releaseBoundary = signal<void>();
        let active = 0;
        let maximumActive = 0;
        let runs = 0;
        const drained: SessionRunnerInput["messages"][] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            const treeAtEntry = SessionHandleStore.tree(input.sessionId);
            const intent = treeAtEntry.find(
              (action: LedgerAction.Node) => action.id === input.turnId,
            );
            expect(SessionHandleStore.turnIntent(intent)?.resultId).toBe(input.resultId);
            expect(
              treeAtEntry.some((action: LedgerAction.Node) => action.id === input.resultId),
            ).toBe(false);
            runs += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            entered.resolve(input);
            yield* awaitSignal(releaseBoundary.promise);
            drained.push([...(yield* awaitSignal(input.boundary("after_llm"))).messages]);
            active -= 1;
            return { kind: "result", text: "done" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("single-flight", runner), fixture), fixture); });

        const first = yield* Effect.fork(handle.prompt("first prompt"));
        const firstInput = yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const secondCommitted = signal<void>();
        const thirdCommitted = signal<void>();
        sink.onCommit = () => {
          const rows = SessionHandleStore.inboxRows(handle.id);
          if (rows.some((row: Inbox.Row) => row.content === "second prompt"))
            secondCommitted.resolve();
          if (rows.some((row: Inbox.Row) => row.content === "third prompt"))
            thirdCommitted.resolve();
        };
        const second = yield* Effect.fork(handle.prompt("second prompt"));
        yield* bounded(secondCommitted.promise, "second prompt committed");
        const third = yield* Effect.fork(handle.prompt("third prompt"));
        yield* bounded(thirdCommitted.promise, "third prompt committed");
        releaseBoundary.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(first), awaitSignal(second), awaitSignal(third)], {
              concurrency: "unbounded",
            }),
            "serialized prompt completion",
          ),
        );

        expect(runs).toBe(1);
        expect(maximumActive).toBe(1);
        expect(firstInput.messages).toEqual([
          {
            id: SessionHandleStore.inboxRows(handle.id)[0]?.id,
            role: "user",
            text: "first prompt",
          },
        ]);
        expect(drained).toEqual([
          [
            {
              id: SessionHandleStore.inboxRows(handle.id)[1]?.id,
              role: "user",
              text: "second prompt",
            },
            {
              id: SessionHandleStore.inboxRows(handle.id)[2]?.id,
              role: "user",
              text: "third prompt",
            },
          ],
        ]);
        expect(
          SessionHandleStore.inboxRows(handle.id).map((row: Inbox.Row) => [
            row.content,
            row.status,
          ]),
        ).toEqual([
          ["first prompt", "consumed"],
          ["second prompt", "consumed"],
          ["third prompt", "consumed"],
        ]);
        expect(
          SessionHandleStore.tree(handle.id)
            .map(SessionHandleStore.delivery)
            .filter(
              (
                delivery:
                  | {
                      phase: "delivery";
                      turnId: string;
                      inboxId: string;
                      kind: "prompt" | "interrupt" | "resume";
                      content: string;
                      origin: { encodingVersion: 1; value: PlainValue };
                      boundary: "before_llm" | "after_llm" | "after_tools";
                    }
                  | undefined,
              ): delivery is SessionTurn.Delivery => delivery !== undefined,
            )
            .map(
              (delivery: {
                phase: "delivery";
                turnId: string;
                inboxId: string;
                kind: "prompt" | "interrupt" | "resume";
                content: string;
                origin: { encodingVersion: 1; value: PlainValue };
                boundary: "before_llm" | "after_llm" | "after_tools";
              }) => delivery.inboxId,
            ),
        ).toEqual(SessionHandleStore.inboxRows(handle.id).map((row: Inbox.Row) => row.id));
      }),
    ));

  test("a turn's ledger refuses a request transition once that turn has sealed", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.sync(() => {
            entered.resolve(input);
            return { kind: "result", text: "done" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("late-transition", runner), fixture), fixture); });
        yield* awaitSignal(bounded(handle.prompt("first prompt"), "prompt completion"));
        const input = yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const request = durableRequest(handle.id, input.turnId);
        const tree = SessionHandleStore.tree(handle.id);
        if (input.ledger.transition === undefined) throw new Error("missing transition port");
        const late = input.ledger.transition({ kind: "request.open", request }, "late:open", now);
        const refused = yield* failure(late);
        expect(refused).toMatchObject({
          _tag: "ForeignFailure",
          operation: "session.request.transition",
          cause: "stale",
        });
        expect(SessionHandleStore.tree(handle.id)).toEqual(tree);
        expect(SessionHandleStore.requestRows()).toEqual([]);
      }),
    ));

  test("an interrupt landing during turn.pre admission seals interrupted without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        let runs = 0;
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("interrupt-before-body", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "ran" };
            }),
          ), fixture), fixture); });
        const admitted = signal<void>();
        const interrupted = signal<void>();
        const sessions = Storage.get().sessions;
        if (sessions === undefined) throw new Error("missing session adapter");
        const commit = sessions.commit;
        const gate = spyOn(sessions, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) =>
            Effect.gen(function* () {
              const receipt = yield* commit(input);
              if (input.state === "interrupted") interrupted.resolve();
              if (
                input.actions.some(
                  (action: LedgerAction.Append) => policyHook(action) === "turn.pre",
                )
              ) {
                admitted.resolve();
                yield* Effect.promise(() => interrupted.promise);
              }
              return receipt;
            }),
        );
        let result: Effect.Effect.Success<ReturnType<SessionHandle["prompt"]>>;
        try {
          const prompt = yield* Effect.fork(handle.prompt("never reaches the runner"));
          yield* bounded(admitted.promise, "turn.pre committed");
          const interrupt = yield* Effect.fork(handle.interrupt());
          result = yield* bounded(prompt, "prompt completion");
          yield* bounded(interrupt, "interrupt receipt");
        } finally {
          gate.mockRestore();
        }
        expect(result).toEqual({ kind: "interrupted", text: "" });
        expect(runs).toBe(0);
        expect(handle.get().state).toBe("interrupted");
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
      }),
    ));

  test("a storage failure during turn admission seals the turn as an error", () =>
    testProgram(
      Effect.gen(function* () {
        let runs = 0;
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("admission-storage-failure", () =>
            Effect.sync(() => {
              runs += 1;
              return { kind: "result", text: "ran" };
            }),
          ), fixture), fixture); });
        const sessions = Storage.get().sessions;
        if (sessions === undefined) throw new Error("missing session adapter");
        const commit = sessions.commit;
        const explode = spyOn(sessions, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) => {
            const decision = input.actions.find(
              (action: LedgerAction.Append) => action.kind === "policy.decision",
            );
            if (decision === undefined || policyHook(decision) !== "turn.pre") return commit(input);
            explode.mockRestore();
            return Effect.fail(
              new ForeignFailure({ operation: "session.commit", cause: "admission fixture" }),
            );
          },
        );
        const result = yield* awaitSignal(
          bounded(handle.prompt("admission fails"), "prompt completion"),
        );
        expect(result).toMatchObject({
          kind: "error",
          cause: {
            _tag: "CommitFailed",
            error: {
              _tag: "ForeignFailure",
              operation: "session.commit",
              cause: "admission fixture",
            },
          },
        });
        expect(runs).toBe(0);
        expect(handle.get().state).toBe("idle");
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
      }),
    ));

  test("records an idle interrupt as a no-op without resuming the next prompt", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("ran once");
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("idle-interrupt", runner), fixture), fixture); });
        yield* SessionHandleStore.commitInbox({
          id: "idle-interrupt:interrupt",
          sessionId: handle.id,
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId: SessionHandleStore.tree(handle.id).at(-1)?.id ?? null,
        });

        const result = yield* awaitSignal(handle.prompt("run after the no-op"));

        expect(result).toEqual({ kind: "result", text: "ran once" });
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.resumeCount).toBe(0);
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
        expect(
          SessionHandleStore.tree(handle.id).filter(
            (action: LedgerAction.Node) => SessionHandleStore.turnResume(action) !== undefined,
          ),
        ).toEqual([]);
      }),
    ));

  test("seals a queued prompt followed by an interrupt without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        let entries = 0;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            entries += 1;
            return { kind: "result", text: "must not run" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("queued-interrupt", runner), fixture), fixture); });
        const parentActionId = SessionHandleStore.tree(handle.id).at(-1)?.id ?? null;
        yield* SessionHandleStore.commitInbox({
          id: "queued-interrupt:prompt",
          sessionId: handle.id,
          kind: "prompt",
          content: "do not run",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId,
        });
        yield* SessionHandleStore.commitInbox({
          id: "queued-interrupt:interrupt",
          sessionId: handle.id,
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId,
        });

        yield* awaitSignal(Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => runner, fixture), fixture); }));

        expect(entries).toBe(0);
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toEqual([]);
        expect(handle.get()).toMatchObject({
          state: "interrupted",
          turns: [{ terminal: { kind: "interrupted" } }],
        });
      }),
    ));

  test("a leading idle interrupt is consumed before a later prompt starts", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("ran once");
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("leading-idle-interrupt", runner), fixture), fixture); });
        const parentActionId = SessionHandleStore.tree(handle.id).at(-1)?.id ?? null;
        yield* SessionHandleStore.commitInbox({
          id: "leading-idle-interrupt:interrupt",
          sessionId: handle.id,
          kind: "interrupt",
          content: "",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now,
          parentActionId,
        });
        yield* SessionHandleStore.commitInbox({
          id: "leading-idle-interrupt:prompt",
          sessionId: handle.id,
          kind: "prompt",
          content: "run afterward",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId,
        });

        yield* awaitSignal(Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => runner, fixture), fixture); }));

        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.resumeCount).toBe(0);
        expect(inputs[0]?.messages).toEqual([
          {
            id: SessionHandleStore.inboxRows(handle.id).find(
              (row: Inbox.Row) => row.kind === "prompt",
            )?.id,
            role: "user",
            text: "run afterward",
          },
        ]);
      }),
    ));

  test("consumes a running interrupt and seals interrupted rather than error", () =>
    testProgram(
      Effect.gen(function* () {
        const ready = signal<AbortSignal>();
        const aborted = signal<void>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            input.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
              },
              { once: true },
            );
            ready.resolve(input.signal);
            yield* awaitSignal(aborted.promise);
            return { kind: "result", text: "late result must not commit" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("interrupt", runner), fixture), fixture); });

        const running = yield* Effect.fork(handle.prompt("start"));
        const runnerSignal = yield* awaitSignal(
          bounded(ready.promise, "interrupt listener installation"),
        );
        const interrupted = yield* Effect.fork(handle.interrupt());
        yield* awaitSignal(bounded(aborted.promise, "runner abort"));
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(interrupted)], {
              concurrency: "unbounded",
            }),
            "interrupted terminal",
          ),
        );

        expect(runnerSignal.aborted).toBe(true);
        expect(SessionHandleStore.inboxRows(handle.id).map((row: Inbox.Row) => row.status)).toEqual(
          ["consumed", "consumed"],
        );
        const terminals = SessionHandleStore.tree(handle.id)
          .map(SessionHandleStore.turnTerminal)
          .filter(
            (
              terminal:
                | {
                    phase: "terminal";
                    turnId: string;
                    kind: "interrupted" | "error" | "result" | "waiting";
                    text: string;
                    boundaryActionId: string | null;
                    resumeCount: number;
                    reason?: "live_wait" | undefined;
                    alarmIds?: string[] | undefined;
                  }
                | undefined,
            ): terminal is SessionTurn.Terminal => terminal !== undefined,
          );
        expect(terminals).toHaveLength(1);
        expect(terminals[0]?.kind).toBe("interrupted");
        expect(handle.get().state).toBe("interrupted");
      }),
    ));

  test("does not overlap a resumed runner when the interrupted runner ignores abort", () =>
    testProgram(
      Effect.gen(function* () {
        const firstEntered = signal<void>();
        const firstAborted = signal<void>();
        const releaseFirst = signal<void>();
        let entries = 0;
        let active = 0;
        let maximumActive = 0;
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            entries += 1;
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            if (entries === 1) {
              input.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
              const settled = releaseFirst.promise.then(() => {
                active -= 1;
              });
              input.retainEffect?.(settled);
              firstEntered.resolve();
              yield* Effect.promise(() => settled);
            } else {
              active -= 1;
            }
            return { kind: "result", text: `run ${entries}` };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("non-cooperative-interrupt", runner), fixture), fixture); });

        const first = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(firstEntered.promise, "first runner entry"));
        const interrupted = yield* Effect.fork(handle.interrupt());
        yield* awaitSignal(bounded(firstAborted.promise, "first runner abort signal"));
        const resumeCommitted = signal<void>();
        sink.onCommit = () => {
          if (
            SessionHandleStore.pendingInbox(handle.id).some(
              (row: Inbox.Row) => row.kind === "resume",
            )
          )
            resumeCommitted.resolve();
        };
        const resumed = yield* Effect.fork(handle.resume());
        yield* bounded(resumeCommitted.promise, "resume committed while raw runner retained");
        expect(entries).toBe(1);
        expect(maximumActive).toBe(1);
        releaseFirst.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(first), awaitSignal(interrupted), awaitSignal(resumed)], {
              concurrency: "unbounded",
            }),
            "serialized resume completion",
          ),
        );

        expect(entries).toBe(2);
        expect(maximumActive).toBe(1);
      }),
    ));

  test("retained turn ownership holds the generation and lease until released", () =>
    testProgram(Effect.gen(function* () {
      const retained = signal<{ readonly release: () => void; readonly pending: () => number }>();
      const runner: SessionRunner = () => Effect.gen(function* () {
        const ownership = yield* GenerationOwnership;
        const owners = yield* ownership.provide(GenerationRawSlots);
        // Admission and the running turn each own a capture.
        const before = owners.pending();
        const release = ownership.retain();
        retained.resolve({ release, pending: owners.pending });
        expect(before).toBe(2);
        expect(owners.pending()).toBe(before + 1);
        return { kind: "result", text: "retained" };
      });
      const { handle, hibernated } = yield* hibernatingSession("retained-generation", runner);
      const result = yield* bounded(handle.prompt("retain ownership"), "retained turn terminal");
      const owner = yield* bounded(retained.promise, "generation retained");
      try {
        expect(result).toEqual({ kind: "result", text: "retained" });
        expect(owner.pending()).toBe(1);
        expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
        expect(yield* failure(contendLease(handle))).toMatchObject({ _tag: "LeaseRefused", reason: "held" });
      } finally {
        owner.release();
      }
      expect(owner.pending()).toBe(0);
      yield* bounded(hibernated.promise, "retained ownership released");
      expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
    })),
  );

  test("keeps the durable lease held through an ignored abort so no other runtime can resume", () =>
    testProgram(
      Effect.gen(function* () {
        const run = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "lease-held-through-abort",
          run.runner,
        );
        const pending = yield* awaitSignal(interruptStubborn(handle, run));

        // The interrupted terminal is sealed promptly, but the runner ignored the
        // abort and is still alive, so the durable lease MUST stay held by this
        // owner. A second runtime/process acquiring it without waiting for the TTL
        // (no clock advance) must be refused, or two live executors could exist for
        // one durable session.
        expect(handle.get().state).toBe("interrupted");
        yield* awaitSignal(expectLeaseHeldUntilSettled(handle, run, pending, hibernated));
      }),
    ));

  test("a retained runner whose lease lapsed does not wedge the handle: the next prompt still runs", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, entered, abortSeen, releaseRunner, calls } = stubbornRunner({
          resumeAfterFirst: true,
        });
        const { handle, hibernated } = yield* hibernatingSession("retained-lease-lapsed", runner);

        const running = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const interrupted = yield* Effect.fork(handle.interrupt());
        yield* awaitSignal(bounded(abortSeen.promise, "runner abort signal"));
        yield* awaitSignal(bounded(interrupted, "interrupt receipt"));

        // The runner outlives its TTL (contract violation) and the lease lapses
        // before it settles. The retained release must treat the lapsed lease as
        // nothing-to-release instead of failing a stale commit and wedging every
        // later turn start behind the detached settlement.
        now += SessionHandleStore.LEASE_TTL_MS;
        releaseRunner.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(hibernated.promise)], {
              concurrency: "unbounded",
            }),
            "retained settlement",
          ),
        );

        const leaseBefore = SessionHandleStore.row(handle.id).leaseFence;
        yield* awaitSignal(bounded(handle.resume(), "resume after retained settlement"));
        expect(calls()).toBe(2);
        expect(handle.get().state).toBe("idle");
        expect(SessionHandleStore.row(handle.id).leaseFence).toBe(leaseBefore + 1);
      }),
    ));

  test("a refused retained release surfaces once to the next turn start and then clears", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, entered, abortSeen, releaseRunner, calls } = stubbornRunner({
          resumeAfterFirst: true,
        });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("retained-release-refused", runner), fixture), fixture); });
        const running = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        yield* awaitSignal(bounded(handle.interrupt(), "interrupt receipt"));
        yield* awaitSignal(bounded(abortSeen.promise, "runner abort signal"));

        const sessions = Storage.get().sessions;
        if (sessions === undefined) throw new Error("missing session adapter");
        const commit = sessions.commit;
        const releaseRefused = signal<void>();
        const refuseRelease = spyOn(sessions, "commit").mockImplementation(
          (input: Parameters<typeof commit>[0]) => {
            if (input.releaseLease && input.actions.length === 0 && input.sessionId === handle.id) {
              refuseRelease.mockRestore();
              releaseRefused.resolve();
              return Effect.fail(
                new ForeignFailure({ operation: "session.commit", cause: "release fixture" }),
              );
            }
            return commit(input);
          },
        );
        releaseRunner.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(releaseRefused.promise)], {
              concurrency: "unbounded",
            }),
            "retained settlement",
          ),
        );

        expect(yield* failure(awaitSignal(handle.resume()))).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "ForeignFailure", operation: "session.commit", cause: "release fixture" },
        });
        yield* awaitSignal(bounded(handle.resume(), "resume after the surfaced failure"));
        expect(calls()).toBe(2);
        expect(handle.get().state).toBe("idle");
        expect(SessionHandleStore.pendingInbox(handle.id)).toEqual([]);
      }),
    ));

  test("configure during the ignored-abort window keeps the lease held by the live runner", () =>
    testProgram(
      Effect.gen(function* () {
        const run = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "configure-in-interrupt-window",
          run.runner,
        );
        const pending = yield* awaitSignal(interruptStubborn(handle, run));
        expect(handle.get().state).toBe("interrupted");
        const fenceBefore = handle.get().lease.fence;

        // A configure while the abort-ignoring runner is still alive must neither
        // rotate the fence nor release the lease: the live executor still owns it.
        const receipt = yield* awaitSignal(
          bounded(handle.tools.add([tool("search")]), "configure receipt"),
        );
        expect(receipt.generation).toBeGreaterThan(0);
        const afterConfigure = handle.get();
        expect(afterConfigure.lease.fence).toBe(fenceBefore);
        expect(afterConfigure.lease.owner).not.toBeNull();
        yield* awaitSignal(
          expectLeaseHeldUntilSettled(handle, run, pending, hibernated, afterConfigure.lease.fence),
        );
      }),
    ));

  test("configure re-entered from the interrupted seal observation still sees the lease as held", () =>
    testProgram(
      Effect.gen(function* () {
        const run = stubbornRunner();
        const { entered } = run;
        const { handle, hibernated } = yield* hibernatingSession(
          "configure-from-seal-observation",
          run.runner,
        );
        // Capture the interrupted seal, then submit configure before releasing the
        // retained raw runner; both operations must observe the same held fence.
        const reentered = signal<() => ReturnType<SessionHandle["tools"]["add"]>>();
        let fenceAtSeal = -1;
        sink.onCommit = (committed: {
          id: string;
          sessionId: string;
          revision: number;
          kind:
            | "message"
            | "prompt"
            | "tool"
            | "attempt"
            | "reply"
            | "outbound"
            | "request"
            | "turn"
            | "llm"
            | "inbox.deliver"
            | "compaction"
            | "alarm.arm"
            | "alarm.fired"
            | "alarm.paused"
            | "session.configure"
            | "policy.decision";
        }) => {
          if (committed.kind !== "turn" || fenceAtSeal !== -1) return;
          const row = SessionHandleStore.row(handle.id);
          if (row.state !== "interrupted") return;
          fenceAtSeal = row.leaseFence;
          const configured = handle.tools.add([tool("search")]);
          reentered.resolve(() => configured);
        };

        const running = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        const interrupted = yield* Effect.fork(handle.interrupt());
        const reentrant = yield* awaitSignal(bounded(reentered.promise, "seal observation"));
        yield* awaitSignal(bounded(reentrant(), "re-entrant configure"));

        const row = SessionHandleStore.row(handle.id);
        expect(row.leaseFence).toBe(fenceAtSeal);
        expect(row.leaseOwner).not.toBeNull();
        expect(yield* failure(contendLease(handle, row.leaseFence))).toMatchObject({
          _tag: "LeaseRefused",
          reason: "held",
        });

        yield* awaitSignal(settleStubborn(handle, run, { running, interrupted }, hibernated));
        expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
        expect(run.maximumActive()).toBe(1);
      }),
    ));

  test("close() returns once a positive grace window lapses while the runner still ignores abort", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, entered, releaseRunner } = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "close-after-positive-grace",
          runner,
          {
            closeGraceMs: 1,
          },
        );

        const running = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        // The interrupt seals the turn while the abort-ignoring runner stays retained,
        // so close() can only return once the grace timer lapses.
        yield* awaitSignal(bounded(handle.interrupt(), "interrupt receipt"));
        try {
          yield* bounded(handle.close().pipe(Effect.disconnect), "close after grace lapse");
          expect(SessionHandleStore.row(handle.id).leaseOwner).not.toBeNull();
        } finally {
          releaseRunner.resolve();
          yield* bounded(
            Effect.all([awaitSignal(running), awaitSignal(hibernated.promise)], {
              concurrency: "unbounded",
            }),
            "runner settlement + lease release",
          );
        }
        expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
      }),
    ));

  test("close() returns after the grace window while the lease stays held until the abort-ignoring runner settles", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, entered, releaseRunner, maximumActive } = stubbornRunner();
        const { handle, hibernated } = yield* hibernatingSession(
          "close-detaches-after-grace",
          runner,
          {
            closeGraceMs: 0,
          },
        );

        const running = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        yield* awaitSignal(bounded(handle.close(), "close with zero grace"));

        // Detached from the caller only: the lease is still held by this executor
        // and its heartbeat keeps renewing, so no second executor can start.
        const row = SessionHandleStore.row(handle.id);
        expect(row.leaseOwner).not.toBeNull();
        expect(yield* failure(contendLease(handle, row.leaseFence))).toMatchObject({
          _tag: "LeaseRefused",
          reason: "held",
        });

        // Once the runner settles the turn continuation releases the lease itself.
        releaseRunner.resolve();
        yield* awaitSignal(
          bounded(
            Effect.all([awaitSignal(running), awaitSignal(hibernated.promise)], {
              concurrency: "unbounded",
            }),
            "runner settlement + lease release",
          ),
        );
        expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
        expect((yield* contendLease(handle, SessionHandleStore.row(handle.id).leaseFence)).ok).toBe(
          true,
        );
        expect(maximumActive()).toBe(1);
      }),
    ));

  test("heartbeat loss aborts the runner and the stale fence cannot seal its result", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<SessionRunnerInput>();
        const aborted = signal<void>();
        let heartbeat: (() => void) | undefined;
        runtime = {
          ...runtime,
          scheduleHeartbeat: (callback: () => void) => {
            heartbeat = callback;
            return () => undefined;
          },
        };
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
            entered.resolve(input);
            yield* awaitSignal(aborted.promise);
            return { kind: "result", text: "stale completion" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("heartbeat-loss", runner), fixture), fixture); });

        const running = yield* Effect.fork(handle.prompt("start"));
        yield* awaitSignal(bounded(entered.promise, "heartbeat runner entry"));
        now += SessionHandleStore.LEASE_TTL_MS;
        const stolen = yield* SessionHandleStore.acquireLease({
          sessionId: handle.id,
          owner: "replacement-owner",
          expectedFence: handle.get().lease.fence,
          now,
          expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
        });
        expect(stolen.ok).toBe(true);
        if (heartbeat === undefined) throw new Error("heartbeat was not scheduled");
        heartbeat();

        yield* awaitSignal(bounded(aborted.promise, "heartbeat abort"));
        expect(yield* failure(awaitSignal(running))).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "CommitRefused" },
        });
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree(handle.id))).toHaveLength(1);
        expect(
          SessionHandleStore.tree(handle.id).some((action: LedgerAction.Node) =>
            SessionHandleStore.turnTerminal(action),
          ),
        ).toBe(false);
      }),
    ));

  test("pins generation N while configure commits generation N+1", () =>
    testProgram(
      Effect.gen(function* () {
        const firstEntered = signal<SessionRunnerInput>();
        const secondEntered = signal<SessionRunnerInput>();
        const releaseFirst = signal<void>();
        const inputs: SessionRunnerInput[] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            inputs.push(input);
            if (inputs.length === 1) {
              firstEntered.resolve(input);
              yield* awaitSignal(releaseFirst.promise);
            } else {
              secondEntered.resolve(input);
            }
            return { kind: "result", text: `generation ${input.toolsGeneration}` };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("configure-pinning", runner), fixture), fixture); });

        const firstTurn = yield* Effect.fork(handle.prompt("turn one"));
        const pinned = yield* awaitSignal(bounded(firstEntered.promise, "generation N runner"));
        const receipt = yield* awaitSignal(handle.tools.add([tool("search")]));
        releaseFirst.resolve();
        yield* awaitSignal(bounded(firstTurn, "generation N terminal"));
        const secondTurn = yield* Effect.fork(handle.prompt("turn two"));
        const next = yield* awaitSignal(bounded(secondEntered.promise, "generation N+1 runner"));
        yield* awaitSignal(bounded(secondTurn, "generation N+1 terminal"));

        expect(receipt).toEqual({ generation: 2, revertTo: 1 });
        expect(pinned.toolsGeneration).toBe(1);
        expect(pinned.tools.map((entry: SessionGeneration.Tool) => entry.name)).toEqual(["read"]);
        expect(next.toolsGeneration).toBe(2);
        expect(next.tools.map((entry: SessionGeneration.Tool) => entry.name)).toEqual([
          "read",
          "search",
        ]);
        expect(next.systemHash).toBe(pinned.systemHash);
      }),
    ));

  test("rejects an existing tool name before committing a configure action", () =>
    testProgram(
      Effect.gen(function* () {
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "unused" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("duplicate-tool", runner), fixture), fixture); });
        const before = handle.get();

        expect(yield* failure(awaitSignal(handle.tools.add([tool("read")])))).toMatchObject({
          name: "SessionConfigureError",
          data: { code: "duplicate_tool" },
        });

        expect(handle.get()).toEqual(before);
        expect(
          SessionHandleStore.tree(handle.id).filter(
            (action: LedgerAction.Node) => action.kind === "session.configure",
          ),
        ).toHaveLength(1);
      }),
    ));

  test("a reactivated handle removes a tool from the next runner generation", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("complete");
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
            ...residentOptions("remove-after-reactivation", runner),
            tools: [tool("read"), tool("search")],
          }, fixture), fixture); });

        yield* awaitSignal(handle.prompt("hibernate the original controller"));
        const receipt = yield* awaitSignal(handle.tools.remove(["read"]));
        yield* awaitSignal(handle.prompt("use the configured generation"));

        expect(receipt).toEqual({ generation: 2, revertTo: 1 });
        expect(inputs.at(-1)?.tools.map((entry: SessionGeneration.Tool) => entry.name)).toEqual([
          "search",
        ]);
      }),
    ));

  test("a reactivated handle replaces system blocks for the next runner generation", () =>
    testProgram(
      Effect.gen(function* () {
        const { runner, inputs } = recordingRunner("complete");
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("blocks-after-reactivation", runner), fixture), fixture); });
        const nextBlocks = [{ id: "safety", source: "operator", content: "Use the safe path." }];

        yield* awaitSignal(handle.prompt("hibernate the original controller"));
        const receipt = yield* awaitSignal(handle.system.blocks.set(nextBlocks));
        yield* awaitSignal(handle.prompt("use the configured generation"));

        expect(receipt).toEqual({ generation: 2, revertTo: 1 });
        expect(inputs).toHaveLength(2);
        expect(inputs[1]?.systemHash).not.toBe(inputs[0]?.systemHash);
        expect(inputs[1]?.tools.map((entry: SessionGeneration.Tool) => entry.name)).toEqual([
          "read",
        ]);
        expect(
          SessionHandleStore.latestGeneration(SessionHandleStore.tree(handle.id)).systemBlocks,
        ).toEqual(nextBlocks);
      }),
    ));

  test("reports typed lease contention from the SQLite-backed session API", () =>
    testProgram(
      Effect.gen(function* () {
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "must not run" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("lease-contention", runner), fixture), fixture); });
        const acquired = yield* SessionHandleStore.acquireLease({
          sessionId: handle.id,
          owner: "other-process",
          expectedFence: 0,
          now,
          expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
        });
        if (!acquired.ok) throw new Error("contention fixture could not acquire its lease");

        expect(yield* failure(awaitSignal(handle.prompt("contended turn")))).toMatchObject({
          _tag: "LeaseRefused",
          reason: "held",
          holder: "other-process",
          fence: 1,
          expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
        });
      }),
    ));

  test("default heartbeat uses an unreferenced timer and clears it after the runner settles", () =>
    testProgram(
      Effect.gen(function* () {
        const entered = signal<void>();
        const release = signal<void>();
        const setIntervalSpy = spyOn(globalThis, "setInterval");
        const clearIntervalSpy = spyOn(globalThis, "clearInterval");
        const runner: SessionRunner = () =>
          Effect.gen(function* () {
            entered.resolve();
            yield* awaitSignal(release.promise);
            return { kind: "result", text: "complete" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = {
          observations: sink,
          clock: runtime.clock,
          entropy: runtime.entropy,
          processId: runtime.processId,
        }; return yield* withSessionServices(session(residentOptions("default-heartbeat", runner), fixture), fixture); });

        const running = yield* Effect.fork(handle.prompt("start"));
        try {
          yield* awaitSignal(bounded(entered.promise, "default-heartbeat runner entry"));
          expect(setIntervalSpy).toHaveBeenCalledTimes(1);
          const timer = setIntervalSpy.mock.results[0]?.value;
          if (
            typeof timer !== "object" ||
            timer === null ||
            !("hasRef" in timer) ||
            typeof timer.hasRef !== "function"
          ) {
            throw new Error("default heartbeat did not return a timer handle");
          }
          expect(timer.hasRef()).toBe(false);
          release.resolve();
          yield* awaitSignal(bounded(running, "default-heartbeat runner completion"));
          expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
        } finally {
          release.resolve();
          yield* awaitSignal(bounded(running, "default-heartbeat cleanup"));
          setIntervalSpy.mockRestore();
          clearIntervalSpy.mockRestore();
        }
      }),
    ));

  test("evicts idle runtime state while a retained handle can rehydrate it", () =>
    testProgram(
      Effect.gen(function* () {
        let hibernations = 0;
        const hibernated = signal<void>();
        runtime = {
          ...runtime,
          onHibernate: () =>
            Effect.sync(() => {
              hibernations += 1;
              hibernated.resolve();
            }),
        };
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "complete" };
          });
        const options = residentOptions("hibernate", runner);
        const first = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(options, fixture), fixture); });

        yield* awaitSignal(first.prompt("sleep after this"));
        yield* awaitSignal(bounded(hibernated.promise, "runtime hibernation"));
        const snapshot = first.get();
        const fenceBeforeGet = snapshot.lease.fence;
        const reopened = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(options, fixture), fixture); });

        expect(snapshot.state).toBe("idle");
        expect(snapshot.turns.at(-1)?.messages).toEqual([
          { role: "user", text: "sleep after this" },
          { role: "assistant", text: "complete" },
        ]);
        expect(hibernations).toBe(1);
        expect(reopened).not.toBe(first);
        expect(first.get().lease.fence).toBe(fenceBeforeGet);
        yield* awaitSignal(first.prompt("wake again"));
        expect(first.get().lease.fence).toBe(fenceBeforeGet + 1);
        expect(hibernations).toBe(2);
      }),
    ));

  test("a hibernated handle routes restore and close through its live successor", () =>
    testProgram(
      Effect.gen(function* () {
        const hibernated = signal<void>();
        runtime = { ...runtime, onHibernate: () => Effect.sync(() => hibernated.resolve()) };
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "complete" };
          });
        const options = residentOptions("hibernate-successor", runner);
        const first = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(options, fixture), fixture); });
        yield* awaitSignal(bounded(first.prompt("sleep after this"), "first prompt"));
        yield* awaitSignal(bounded(hibernated.promise, "runtime hibernation"));
        const successor = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(options, fixture), fixture); });
        expect(successor).not.toBe(first);

        expect(
          yield* failure(awaitSignal(first.restoreContext("missing-compaction"))),
        ).toMatchObject({
          name: "ContextRestoreError",
          code: "context_restore_refused",
          reason: "unknown_compaction",
        });
        yield* awaitSignal(bounded(first.close(), "close through successor"));
        expect(yield* failure(successor.prompt("after close"))).toMatchObject({
          _tag: "ForeignFailure",
          operation: "session.handle",
          cause: "closed",
        });
        expect(yield* failure(first.prompt("after close"))).toMatchObject({
          _tag: "ForeignFailure",
          operation: "session.handle",
          cause: "closed",
        });
      }),
    ));

  test("approval answers reach only a turn's live approvals", () =>
    testProgram(
      Effect.gen(function* () {
        const answers: Parameters<ExecutionApprovals["answer"]>[0][] = [];
        const entered = signal<void>();
        const release = signal<void>();
        const livePending: ExecutionApprovalRequest[] = [];
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            input.bindApprovals?.({
              pending: () => livePending,
              notify: () => undefined,
              answer: (answer: Parameters<ExecutionApprovals["answer"]>[0]) =>
                Effect.sync(() => {
                  answers.push(answer);
                }),
            });
            entered.resolve();
            yield* awaitSignal(release.promise);
            return { kind: "result", text: "done" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("approval-routing", runner), fixture), fixture); });
        const request = approvalRequest(handle.id, "turn");
        livePending.push(request);
        const answer = {
          request,
          credential: "owner-token",
          decision: "approve",
        } as const;
        expect(handle.approvals.pending()).toEqual([]);
        expect(yield* failure(awaitSignal(handle.approvals.answer(answer)))).toMatchObject({
          code: "stale_approval",
        });
        const prompted = yield* Effect.fork(handle.prompt("needs approval"));
        yield* awaitSignal(bounded(entered.promise, "runner entry"));
        expect(handle.approvals.pending()).toBe(livePending);
        yield* awaitSignal(bounded(handle.approvals.answer(answer), "routed answer"));
        expect(answers).toEqual([answer]);
        release.resolve();
        yield* awaitSignal(bounded(prompted, "prompt completion"));
      }),
    ));

  test("resume after interruption carries no prompt content into the runner", () =>
    testProgram(
      Effect.gen(function* () {
        const firstEntered = signal<SessionRunnerInput>();
        const firstAborted = signal<void>();
        const resumed = signal<SessionRunnerInput>();
        let entries = 0;
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.gen(function* () {
            entries += 1;
            if (entries === 1) {
              firstEntered.resolve(input);
              input.signal.addEventListener("abort", () => firstAborted.resolve(), { once: true });
              yield* awaitSignal(firstAborted.promise);
              return { kind: "interrupted" };
            }
            resumed.resolve(input);
            return { kind: "result", text: "resumed" };
          });
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("content-free-resume", runner), fixture), fixture); });

        const first = yield* Effect.fork(handle.prompt("original prompt"));
        const firstInput = yield* awaitSignal(
          bounded(firstEntered.promise, "initial runner entry"),
        );
        yield* awaitSignal(handle.interrupt());
        yield* awaitSignal(bounded(first, "interrupted turn"));
        const resume = yield* Effect.fork(handle.resume());
        const resumedInput = yield* awaitSignal(bounded(resumed.promise, "resumed runner entry"));
        yield* awaitSignal(bounded(resume, "resumed turn"));

        expect(resumedInput.messages).toEqual(firstInput.messages);
        expect(resumedInput.resumeCount).toBe(1);
        expect(
          SessionHandleStore.tree(handle.id)
            .map(SessionHandleStore.delivery)
            .filter(
              (
                item:
                  | {
                      phase: "delivery";
                      turnId: string;
                      inboxId: string;
                      kind: "prompt" | "interrupt" | "resume";
                      content: string;
                      origin: { encodingVersion: 1; value: PlainValue };
                      boundary: "before_llm" | "after_llm" | "after_tools";
                    }
                  | undefined,
              ): item is SessionTurn.Delivery => item !== undefined,
            )
            .filter(
              (item: {
                phase: "delivery";
                turnId: string;
                inboxId: string;
                kind: "prompt" | "interrupt" | "resume";
                content: string;
                origin: { encodingVersion: 1; value: PlainValue };
                boundary: "before_llm" | "after_llm" | "after_tools";
              }) => item.kind === "resume",
            )
            .map(
              (item: {
                phase: "delivery";
                turnId: string;
                inboxId: string;
                kind: "prompt" | "interrupt" | "resume";
                content: string;
                origin: { encodingVersion: 1; value: PlainValue };
                boundary: "before_llm" | "after_llm" | "after_tools";
              }) => item.content,
            ),
        ).toEqual([""]);
      }),
    ));

  test.each([
    "result",
    "error",
    "interrupted",
  ] as const)("child %s terminal offers the original parent letter to the atomic commit port", (kind:
    | "interrupted"
    | "error"
    | "result") =>
    testProgram(
      Effect.gen(function* () {
        const parent = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("request-parent", () =>
            Effect.sync(() => {
              return { kind: "result", text: "parent" };
            }),
          ), fixture), fixture); });
        expect(
          Storage.get().actions?.append(
            {
              id: "original-send",
              sessionId: parent.id,
              parentId: null,
              kind: "message",
              intent: { encodingVersion: 1, value: { phase: "intent", messageId: "request" } },
              effect: { encodingVersion: 1, value: { phase: "pending" } },
              irreversible: true,
              ts: now,
            },
            SessionHandleStore.row(parent.id).revision,
          ),
        ).toBeDefined();
        let commits = 0;
        runtime = {
          ...runtime,
          dispatchOutbound: ({
            message,
          }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
            Effect.gen(function* () {
              commits += 1;
              expect(
                SessionHandleStore.tree(message.sourceSessionId).some(
                  (action: LedgerAction.Node) =>
                    SessionHandleStore.turnTerminal(action) !== undefined,
                ),
              ).toBe(true);
              expect(SessionHandleStore.outboundRows(message.sourceSessionId)[0]?.state).toBe(
                "pending",
              );
              expect(SessionHandleStore.inboxRows(parent.id)).toEqual([]);
              expect(message).toMatchObject({
                requestId: "original-send",
                replyTo: "original-binding",
                sourceSessionId: "reply-child",
                terminal: kind === "result" ? "completed" : kind,
              });
              return (yield* SessionHandleStore.commitReceivedMessage({
                id: message.messageId,
                sessionId: message.destinationSessionId,
                kind: "prompt",
                content: message.content,
                createdAt: now,
                parentActionId: null,
                origin: { encodingVersion: 1, value: message },
              }).pipe(
                Effect.mapError(
                  (error: import("@openomni/ledger").LedgerError) => new CommitFailed({ error }),
                ),
              )).receipt;
            }),
        };
        const worker = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
            id: "reply-child",
            parentId: parent.id,
            role: "worker",
            tools: [],
            system,
            runner: () =>
              Effect.sync(() => {
                return { kind, text: "terminal-text" };
              }),
          }, fixture), fixture); });
        yield* awaitSignal(
          worker.prompt("work", {
            encodingVersion: 1,
            value: {
              kind: "message",
              messageId: "request",
              senderSessionId: parent.id,
              sourceActionId: "original-send",
              replyTo: "original-binding",
              deadline: now + 1000,
            },
          }),
        );
        expect(commits).toBe(1);
        expect(
          SessionHandleStore.inboxRows(parent.id).map((row: Inbox.Row) => row.content),
        ).toEqual(["terminal-text"]);
        expect(
          SessionHandleStore.tree(worker.id).flatMap((action: LedgerAction.Node) => {
            const terminal = SessionHandleStore.turnTerminal(action);
            return terminal === undefined ? [] : [terminal.kind];
          }),
        ).toEqual([kind]);
      }),
    ));

  test("materializes a worker as a parent-linked session with an independent lease", () =>
    testProgram(
      Effect.gen(function* () {
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            return { kind: "result", text: "done" };
          });
        const parent = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("resident-parent", runner), fixture), fixture); });
        const worker = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
            id: "worker-child",
            parentId: parent.id,
            role: "worker",
            runner,
            tools: [tool("read")],
            system,
          }, fixture), fixture); });

        yield* awaitSignal(worker.prompt("do the work"));

        expect(worker.id.startsWith("delegation-")).toBe(false);
        expect(worker.get()).toMatchObject({ parentId: parent.id, role: "worker", revision: 9 });
        expect(SessionHandleStore.row(parent.id).leaseFence).toBe(0);
        expect(SessionHandleStore.row(worker.id).leaseFence).toBe(1);
      }),
    ));
});

describe("session crash recovery and observation", () => {
  test("boot sweep resumes with the original pre-minted result id", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "crashed-turn",
          resultId: "preminted-result",
          resumeCount: 0,
        });
        const entered = signal<SessionRunnerInput>();
        const runner: SessionRunner = (input: SessionRunnerInput) =>
          Effect.sync(() => {
            entered.resolve(input);
            return { kind: "result", text: "recovered" };
          });

        const sweeping = yield* Effect.fork(Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => runner, fixture), fixture); }));
        const input = yield* awaitSignal(bounded(entered.promise, "recovered runner entry"));
        yield* awaitSignal(bounded(sweeping, "boot sweep terminal"));

        expect(input.resultId).toBe("preminted-result");
        expect(input.resumeCount).toBe(1);
        const terminal = SessionHandleStore.tree("crashed-turn").find(
          (action: LedgerAction.Node) => SessionHandleStore.turnTerminal(action) !== undefined,
        );
        expect(terminal?.id).toBe("preminted-result");
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree("crashed-turn"))).toEqual([]);
      }),
    ));

  test("boot sweep refuses an open turn whose pinned generation no longer matches the ledger", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "drifted-turn",
          resultId: "drifted-result",
          resumeCount: 0,
          toolsHash: "not-the-recorded-tools",
        });
        let runs = 0;
        const sweeping = yield* Effect.fork(
          Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => () =>
              Effect.sync(() => {
                runs += 1;
                return { kind: "result", text: "must not run" };
              }), fixture), fixture); }),
        );
        expect(yield* failure(awaitSignal(sweeping))).toMatchObject({
          _tag: "GenerationUnavailable",
          generation: 1,
        });
        expect(runs).toBe(0);
        expect(SessionHandleStore.openTurns(SessionHandleStore.tree("drifted-turn"))).toHaveLength(
          1,
        );
      }),
    ));

  test("a prompt denied at a mid-turn boundary is consumed and fails the runner's drain", () =>
    testProgram(
      Effect.gen(function* () {
        yield* awaitSignal(
          Effect.gen(function* () {
            Storage.reset();
            Storage.initialize({ dbPath: ":memory:", observationSink: sink });
            seedPolicy([
              {
                name: "deny-boundary-prompt",
                kind: "prompt",
                phase: "pre",
                match: { encodingVersion: 1, value: { op: "inbox", sessionId: "boundary-deny" } },
                verdict: {
                  encodingVersion: 1,
                  value: { type: "deny", reason: "late prompt refused" },
                },
                priority: 2_000,
              },
            ]);
            yield* commitOpenTurn({
              sessionId: "boundary-deny",
              resultId: "boundary-result",
              resumeCount: 0,
            });
            const isolatedRuntime = { ...runtime };
            const drained = signal<unknown>();
            const runner: SessionRunner = (input: SessionRunnerInput) =>
              Effect.gen(function* () {
                yield* SessionHandleStore.commitInbox({
                  id: "boundary-deny:late",
                  sessionId: input.sessionId,
                  kind: "prompt",
                  content: "late prompt",
                  origin: { encodingVersion: 1, value: { source: "test" } },
                  createdAt: now,
                  parentActionId: SessionHandleStore.tree(input.sessionId).at(-1)?.id ?? null,
                }).pipe(
                  Effect.mapError(
                    (error: import("@openomni/ledger").LedgerError) => new CommitFailed({ error }),
                  ),
                );
                const boundary = yield* Effect.either(input.boundary("after_llm"));
                if (boundary._tag === "Left") {
                  drained.resolve(boundary.left);
                  return yield* Effect.fail(boundary.left);
                }
                return { kind: "result", text: JSON.stringify(boundary.right) };
              });
            yield* awaitSignal(
              bounded(
                Effect.gen(function* () { const fixture: SessionFixture = isolatedRuntime; return yield* withSessionServices(sweepSessions(() => runner, fixture), fixture); }),
                "boot sweep terminal",
              ),
            );
            expect(yield* awaitSignal(bounded(drained.promise, "boundary refusal"))).toMatchObject({
              _tag: "ForeignFailure",
              operation: "session.prompt",
              cause: "late prompt refused",
            });
            const tree = SessionHandleStore.tree("boundary-deny");
            expect(
              SessionHandleStore.turnTerminal(
                tree.find((action: LedgerAction.Node) => action.id === "boundary-result"),
              ),
            ).toMatchObject({ kind: "error" });
            expect(
              tree
                .filter((action: LedgerAction.Node) => action.kind === "policy.decision")
                .map(policyHook),
            ).toEqual(["turn.pre", "prompt.pre"]);
            expect(
              tree
                .map(SessionHandleStore.delivery)
                .filter(
                  (
                    d:
                      | {
                          phase: "delivery";
                          turnId: string;
                          inboxId: string;
                          kind: "prompt" | "interrupt" | "resume";
                          content: string;
                          origin: { encodingVersion: 1; value: PlainValue };
                          boundary: "before_llm" | "after_llm" | "after_tools";
                        }
                      | undefined,
                  ) => d !== undefined,
                ),
            ).toEqual([]);
            expect(
              SessionHandleStore.inboxRows("boundary-deny").map((row: Inbox.Row) => row.status),
            ).toEqual(["consumed"]);
            yield* awaitSignal(closeSessions(isolatedRuntime));
            Storage.reset();
          }),
        );
      }),
    ));

  test("boot sweep seals a durable interrupt before admitting an open turn", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "cancelled-turn",
          resultId: "cancelled-result",
          resumeCount: 0,
        });
        yield* SessionHandleStore.commitInbox({
          id: "cancel-request",
          sessionId: "cancelled-turn",
          kind: "interrupt",
          content: "",
          createdAt: now,
          origin: { encodingVersion: 1, value: { kind: "sdk" } },
          parentActionId: "cancelled-turn:turn",
        });
        const prefix = SessionHandleStore.tree("cancelled-turn");
        let runnerEntries = 0;
        yield* awaitSignal(
          bounded(
            Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => () =>
                Effect.sync(() => {
                  runnerEntries += 1;
                  return { kind: "result", text: "must not run" };
                }), fixture), fixture); }),
            "cancelled open turn seal",
          ),
        );
        expect(runnerEntries).toBe(0);
        const actions = SessionHandleStore.tree("cancelled-turn");
        expect(actions.slice(0, prefix.length)).toEqual(prefix);
        expect(
          SessionHandleStore.turnTerminal(
            actions.find((action: LedgerAction.Node) => action.id === "cancelled-result"),
          ),
        ).toMatchObject({ kind: "interrupted", turnId: "cancelled-turn:turn", resumeCount: 0 });
        expect(SessionHandleStore.pendingInbox("cancelled-turn")).toEqual([]);
        expect(SessionHandleStore.row("cancelled-turn").leaseOwner).toBeNull();
      }),
    ));

  test("boot sweep seals error at resume budget ten without entering the runner", () =>
    testProgram(
      Effect.gen(function* () {
        yield* commitOpenTurn({
          sessionId: "poison-turn",
          resultId: "poison-result",
          resumeCount: 10,
        });
        let runnerEntries = 0;
        const runner: SessionRunner = () =>
          Effect.sync(() => {
            runnerEntries += 1;
            return { kind: "result", text: "must not run" };
          });

        yield* awaitSignal(
          bounded(
            Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(sweepSessions(() => runner, fixture), fixture); }),
            "resume budget terminal",
          ),
        );

        expect(runnerEntries).toBe(0);
        const terminalAction = SessionHandleStore.tree("poison-turn").find(
          (action: LedgerAction.Node) => action.id === "poison-result",
        );
        expect(SessionHandleStore.turnTerminal(terminalAction)).toMatchObject({
          kind: "error",
          resumeCount: 10,
        });
      }),
    ));

  test("a resume for an interrupted session without any terminal is consumed as a no-op", () =>
    testProgram(
      Effect.gen(function* () {
        const runs: string[] = [];
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("interrupted-without-terminal", (input: SessionRunnerInput) =>
            Effect.sync(() => {
              runs.push(input.turnId);
              return { kind: "result", text: "never" };
            }),
          ), fixture), fixture); });
        const row = SessionHandleStore.row(handle.id);
        const lease = yield* SessionHandleStore.acquireLease({
          sessionId: handle.id,
          owner: "earlier-runtime",
          expectedFence: row.leaseFence,
          now,
          expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
        });
        if (!lease.ok) throw new Error("test lease refused");
        const marked = yield* SessionHandleStore.commit({
          sessionId: handle.id,
          owner: "earlier-runtime",
          fence: lease.fence,
          now,
          expectedRevision: SessionHandleStore.row(handle.id).revision,
          actions: [],
          consumeInboxIds: [],
          state: "interrupted",
          releaseLease: true,
        });
        if (!marked.ok) throw new Error("test interrupt refused");

        expect(
          yield* awaitSignal(bounded(handle.resume(), "resume without terminal")),
        ).toBeUndefined();
        expect(runs).toEqual([]);
        expect(handle.get().state).toBe("interrupted");
        expect(SessionHandleStore.pendingInbox(handle.id)).toEqual([]);
        expect(
          SessionHandleStore.tree(handle.id)
            .map(SessionHandleStore.delivery)
            .filter(
              (
                delivery:
                  | {
                      phase: "delivery";
                      turnId: string;
                      inboxId: string;
                      kind: "prompt" | "interrupt" | "resume";
                      content: string;
                      origin: { encodingVersion: 1; value: PlainValue };
                      boundary: "before_llm" | "after_llm" | "after_tools";
                    }
                  | undefined,
              ): delivery is SessionTurn.Delivery => delivery !== undefined,
            )
            .map(
              (delivery: {
                phase: "delivery";
                turnId: string;
                inboxId: string;
                kind: "prompt" | "interrupt" | "resume";
                content: string;
                origin: { encodingVersion: 1; value: PlainValue };
                boundary: "before_llm" | "after_llm" | "after_tools";
              }) => delivery.turnId,
            ),
        ).toEqual(["noop"]);
      }),
    ));

  test("watch installs its subscription before reading the initial snapshot", () =>
    testProgram(
      Effect.gen(function* () {
        yield* SessionHandleStore.materialize({
          id: "watch-order",
          parentId: null,
          role: "resident",
          tools: [],
          system: { preset: "", blocks: [] },
          policyGeneration: 0,
          actionId: "watch-order:configure",
          at: now,
        });
        let subscribed = false;
        const adapter = Storage.get();
        const sessions = adapter.sessions;
        if (sessions === undefined) throw new Error("session adapter is unavailable");
        const get = sessions.get.bind(sessions);
        Storage.configure({
          ...adapter,
          transaction: adapter.transaction.bind(adapter),
          sessions: {
            ...sessions,
            get: (id: string) => {
              expect(subscribed).toBe(true);
              return get(id);
            },
          },
        });
        const watch = SessionHandleStore.watchSnapshot("watch-order", 1, {
          publish: () => undefined,
          subscribe: () => {
            subscribed = true;
            return () => undefined;
          },
        });

        watch.unsubscribe();
      }),
    ));

  test("watch reports a revision gap and get replaces state after a dropped observation", () =>
    testProgram(
      Effect.gen(function* () {
        const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session(residentOptions("watched-session", () =>
            Effect.sync(() => {
              return { kind: "result", text: "unused" };
            }),
          ), fixture), fixture); });
        const configureId = SessionHandleStore.tree(handle.id)[0]?.id;
        if (configureId === undefined) throw new Error("missing configure action");
        const watch = handle.watch();
        const observed = signal<SessionTurn.Observation>();
        const stop = watch.subscribe(observed.resolve);
        sink.dropNextCommit = true;

        yield* SessionHandleStore.commitInbox({
          id: "watched-session:prompt-1",
          sessionId: "watched-session",
          kind: "prompt",
          content: "first",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 1,
          parentActionId: configureId,
        });
        yield* SessionHandleStore.commitInbox({
          id: "watched-session:prompt-2",
          sessionId: "watched-session",
          kind: "prompt",
          content: "second",
          origin: { encodingVersion: 1, value: { source: "test" } },
          createdAt: now + 2,
          parentActionId: "watched-session:prompt-1",
        });

        expect(yield* awaitSignal(bounded(observed.promise, "revision gap"))).toEqual({
          kind: "gap",
          sessionId: "watched-session",
          from: watch.snapshot.revision,
          to: 3,
        });
        expect(handle.get().revision).toBe(3);
        stop();
        watch.unsubscribe();
      }),
    ));
});
