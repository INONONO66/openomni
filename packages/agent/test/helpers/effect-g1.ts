import { Cause, Effect, Exit } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import { createExecutor } from "../../src/executor";
import type { ExecutorOptions, ExecutionLedger } from "../../src/executor-contract";
import type { SessionRuntime } from "../../src/session-contract";
import { commitSessionRequest } from "../../src/session-admission";
import { ForeignFailure } from "../../src/errors";
import { allowAllPolicy, fixtureHashes } from "./compiled-policy";
import type { CompiledPolicySnapshot } from "@openomni/policy";
export { createTestAgent, runTestAgent, runChatAttempts } from "./effect-g2";
export const nullRetryAlarm: NonNullable<ExecutorOptions["retryAlarm"]> = { arm: () => Effect.void, wait: () => Effect.void, settle: () => Effect.void };
export function recordingExecutor(options: { policy?: CompiledPolicySnapshot; onCommit?: (action: LedgerAction.Append) => void | Promise<void>; onObservation?: (name: string) => void; clock?: () => number } = {}) {
  const committed: LedgerAction.Append[] = [];
  let ordinal = 0;
  const executor = createExecutor({
    policy: options.policy ?? allowAllPolicy,
    retryAlarm: nullRetryAlarm,
    ledger: { commit: (action: LedgerAction.Append) => Effect.gen(function* () {
      committed.push(action);
      yield* Effect.promise(async () => { await options.onCommit?.(action); });
      ordinal += 1;
      return { action: { ...action, ordinal, ...fixtureHashes(ordinal) }, revision: ordinal };
    }) },
    observations: { publish: (event) => options.onObservation?.(event.name) },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: options.clock ?? (() => 1), entropy: () => `action-${committed.length + 1}`,
  });
  return { executor, committed };
}
export function turnExecutor(policy: CompiledPolicySnapshot, committed: LedgerAction.Append[] = [], overrides: Partial<ExecutorOptions> = {}) {
  let ordinal = 0;
  const executor = createExecutor({
    policy, retryAlarm: nullRetryAlarm,
    ledger: { commit: (action: LedgerAction.Append) => Effect.sync(() => {
      committed.push(action); ordinal += 1;
      return { action: { ...action, ordinal, ...fixtureHashes(ordinal) }, revision: ordinal };
    }) },
    observations: { publish: () => undefined }, identity: { sessionId: "session-1", role: "resident", parentActionId: "turn-1" },
    clock: () => 1, entropy: () => `action-${committed.length + 1}`, ...overrides,
  });
  return { executor, committed };
}
export function failure<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.exit(program).pipe(Effect.map((exit: Exit.Exit<A, E>): unknown => {
    if (Exit.isSuccess(exit)) throw new Error("expected failed Effect");
    return Cause.squash(exit.cause);
  }));
}
export function requestLedger(input: { id?: string; clock?: () => number; onRequest?: (request: SessionTransition.Request) => void; domainRevisions?: SessionRuntime["requestDomainRevisions"] } = {}) {
  return Effect.gen(function* () {
    const id = input.id ?? "request-session";
    const clock = input.clock ?? (() => 100);
    const created = yield* SessionHandleStore.materialize({ id, role: "resident", parentId: null, policyGeneration: 1, tools: [], system: { preset: "", blocks: [] }, actionId: `${id}:configure`, at: clock() });
    const owner = `${id}:owner`;
    const lease = yield* SessionHandleStore.acquireLease({ sessionId: id, owner, expectedFence: created.row.leaseFence, now: clock(), expiresAt: clock() + 30_000 });
    const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id));
    const turnId = `${id}:turn`;
    if (!SessionHandleStore.tree(id).some((action: LedgerAction.Node) => action.id === turnId)) yield* SessionHandleStore.commit({
      sessionId: id, owner, fence: lease.fence, now: clock(), expectedRevision: SessionHandleStore.row(id).revision, consumeInboxIds: [], state: "running", releaseLease: false,
      actions: [{ id: turnId, sessionId: id, parentId: `${id}:configure`, kind: "turn", intent: { encodingVersion: 1, value: { phase: "intent", resultId: `${id}:result`, inboxIds: [], resumeCount: 0, boundaryActionId: null, toolsGeneration: generation.generation, toolsHash: generation.toolsHash, systemHash: generation.systemHash, policyGeneration: 1 } }, effect: { encodingVersion: 1, value: { phase: "pending" } }, ts: clock(), irreversible: true }],
    });
    const runtime: SessionRuntime = { clock, observations: { publish: () => undefined }, requestDomainRevisions: input.domainRevisions };
    const ledger: ExecutionLedger = {
      actions: () => SessionHandleStore.tree(id),
      commit: (action: LedgerAction.Append) => Effect.gen(function* () {
        const row = SessionHandleStore.row(id);
        const committed = yield* SessionHandleStore.commit({ sessionId: id, owner, fence: lease.fence, now: clock(), expectedRevision: row.revision, actions: [action], consumeInboxIds: [], state: row.state, releaseLease: false });
        const receipt = committed.receipts[0];
        if (receipt === undefined) throw new Error("test receipt missing");
        return receipt;
      }),
      transition: (payload: SessionTransition.Payload, inputId: string, at: number) => commitSessionRequest(id, { owner, fence: lease.fence }, payload, inputId, at, runtime).pipe(Effect.tap((decision) => Effect.sync(() => { if (decision.request !== undefined) input.onRequest?.(decision.request); }))),
    };
    return { ledger, identity: { sessionId: id, role: "resident" as const, parentActionId: turnId, turnId, toolsGeneration: generation.generation, toolsHash: generation.toolsHash, systemHash: generation.systemHash }, entropy: () => crypto.randomUUID(), clock };
  });
}
export type RequestLedger = Effect.Effect.Success<ReturnType<typeof requestLedger>>;
export function crashAfterRequestOpen(initial: RequestLedger, operation: string): RequestLedger {
  const transition = initial.ledger.transition;
  if (transition === undefined) throw new Error("missing transition");
  return { ...initial, ledger: { ...initial.ledger, transition: (payload: SessionTransition.Payload, inputId: string, at: number) => transition(payload, inputId, at).pipe(Effect.flatMap((decision) => payload.kind === "request.open" ? Effect.fail(new ForeignFailure({ operation, cause: "crash" })) : Effect.succeed(decision))) } };
}
