import { Effect, Fiber, Option, Scope } from "effect";
import { LeaseRefused, SessionHandleStore } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { Inbox, LedgerAction, LedgerSession } from "@openomni/protocol";
import { entropyOf } from "./core/entropy";
import { CommitFailed, ExecutionApprovalError, ForeignFailure, type SessionError } from "./errors";
import type { SessionController, SessionControllerLifecycle, SessionRuntime, SessionRunner, SessionRunnerResult, SessionHandle, SessionToolsHandle, SessionSystemBlocksHandle } from "./session-contract";
import { toolSnapshot, internalOrigin, turnTerminalAction } from "./session-record";
import type { SessionControllerState } from "./session-controller-state";
import { createSessionTurn } from "./session-turn";
import { createSessionAdmission, commitSessionRequest } from "./session-admission";
import { createSessionConfiguration } from "./session-configuration";
import { dispatchSessionOutbound } from "./session-outbound";
import { inspectSession } from "./session-lifecycle/inspect";
import { makeSessionGenerations } from "./session-generations";
import { createRawSlots } from "./executor-raw";

export function createController(
  sessionId: string,
  runner: SessionRunner,
  runtime: SessionRuntime,
  lifecycle: SessionControllerLifecycle,
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
  scope: Scope.Scope,
): Effect.Effect<SessionController, SessionError> {
  return Effect.gen(function* () {
    const clock = runtime.clock ?? Date.now;
    const entropy = entropyOf(runtime);
    const owner = `${runtime.processId ?? String(process.pid)}:${entropy()}`;
    const state: SessionControllerState = {
      active: undefined, controller: undefined, fence: SessionHandleStore.row(sessionId).leaseFence,
      closed: false, terminalFrozen: false, released: false, successor: undefined,
      heartbeat: undefined, retainedRunner: undefined, retainedFailure: undefined,
      rawSlots: createRawSlots(), activeApprovals: undefined,
    };
    const generations = yield* Effect.cached(Effect.suspend(() => runtime.generation === undefined
      ? Effect.succeed(undefined)
      : makeSessionGenerations(runtime.generation(SessionHandleStore.latestGenerationFor(sessionId))).pipe(Effect.provideService(Scope.Scope, scope))));
    const { configure, acquire, leaseLive, releaseHeldLease } = createSessionConfiguration(
      sessionId, runtime, state, owner, clock, entropy, { hibernate, generations },
    );
    const { runTurn, seal } = createSessionTurn(
      sessionId, runner, runtime, state, owner, clock, entropy, runtime.scheduleHeartbeat ?? defaultHeartbeat,
      pinPolicy, scope, {
        createExecutionLedger: (...args) => admission.createExecutionLedger(...args),
        evaluatePromptPolicies: (...args) => admission.evaluatePromptPolicies(...args),
        consumePolicyBlockedInbox: (...args) => admission.consumePolicyBlockedInbox(...args),
        releaseHeldLease, hibernate, generations,
      },
    );
    const admission = createSessionAdmission(sessionId, runtime, state, owner, clock, entropy, pinPolicy, {
      awaitRetainedRunner, acquire, runTurn, seal, releaseHeldLease,
    });

    function replacement(): Effect.Effect<SessionHandle | undefined, SessionError> {
      return Effect.gen(function* () {
        if (state.closed) return yield* new ForeignFailure({ operation: "session.handle", cause: "closed" });
        if (!state.released) return undefined;
        state.successor ??= yield* lifecycle.reactivate();
        return state.successor;
      });
    }
    const tools: SessionToolsHandle = {
      add: (additions) => Effect.gen(function* () {
        const nextHandle = yield* replacement();
        if (nextHandle !== undefined) return yield* nextHandle.tools.add(additions);
        const current = SessionHandleStore.latestGenerationFor(sessionId);
        return yield* configure("tools.add", [...current.tools, ...additions.map(toolSnapshot)], { preset: current.systemPreset, blocks: current.systemBlocks });
      }),
      remove: (names) => Effect.gen(function* () {
        const nextHandle = yield* replacement();
        if (nextHandle !== undefined) return yield* nextHandle.tools.remove(names);
        const current = SessionHandleStore.latestGenerationFor(sessionId);
        return yield* configure("tools.remove", current.tools.filter((tool) => !names.includes(tool.name)), { preset: current.systemPreset, blocks: current.systemBlocks });
      }),
    };
    const blocks: SessionSystemBlocksHandle = {
      set: (nextBlocks) => Effect.gen(function* () {
        const nextHandle = yield* replacement();
        if (nextHandle !== undefined) return yield* nextHandle.system.blocks.set(nextBlocks);
        const current = SessionHandleStore.latestGenerationFor(sessionId);
        return yield* configure("system.blocks.set", current.tools, { preset: current.systemPreset, blocks: nextBlocks });
      }),
    };
    const settleClose = () => Effect.gen(function* () {
      const active = state.active;
      if (active !== undefined) yield* Fiber.await(active);
      yield* state.rawSlots.awaitSettled;
    });
    const releasedClose = () => Effect.gen(function* () {
      state.closed = true;
      if (state.successor !== undefined) yield* state.successor.close();
    });
    const releaseAfterClose = () => Effect.gen(function* () {
      if (state.active !== undefined || state.rawSlots.pending() > 0) return;
      yield* releaseHeldLease();
      state.released = true;
      lifecycle.release();
    });
    const handle: SessionHandle = {
      id: sessionId, tools, system: { blocks },
      requests: {
        transition: (payload, inputId, at, inbox) => Effect.gen(function* () {
          const current = SessionHandleStore.row(sessionId);
          const ownsLease = current.leaseOwner === owner && current.leaseFence === state.fence && leaseLive(current);
          if (!ownsLease) {
            // A live runner still holds this controller's authority; an expired lease under
            // it is stale, never silently re-fenced beneath the running turn.
            if (state.active !== undefined) return yield* Effect.fail(new CommitFailed({ error: new LeaseRefused({
              sessionId, reason: "stale", holder: current.leaseOwner, fence: current.leaseFence, expiresAt: current.leaseExpiresAt,
            }) }));
            state.fence = yield* acquire(current.leaseFence).pipe(Effect.mapError((error) => new CommitFailed({ error })));
          }
          return yield* commitSessionRequest(sessionId, { owner, fence: state.fence }, payload, inputId, Math.max(at, clock()), runtime, inbox).pipe(
            Effect.tap((decision) => Effect.sync(() => {
              if (decision.request !== undefined) state.activeApprovals?.notify?.(decision.request);
            })),
            Effect.onExit(() => ownsLease ? Effect.void : releaseHeldLease().pipe(Effect.orDie)),
          );
        }),
      },
      approvals: {
        pending: () => state.activeApprovals?.pending() ?? [],
        answer: (answer) => Effect.suspend(() => state.activeApprovals === undefined
          ? Effect.fail(new ExecutionApprovalError({ code: "stale_approval" })) : state.activeApprovals.answer(answer)),
      },
      prompt: (content, origin = internalOrigin(sessionId)) => Effect.gen(function* () {
        const next = yield* replacement();
        return yield* (next === undefined ? enqueue("prompt", content, origin) : next.prompt(content, origin));
      }),
      interrupt: (origin = internalOrigin(sessionId)) => Effect.gen(function* () {
        const next = yield* replacement();
        yield* (next === undefined ? enqueue("interrupt", "", origin) : next.interrupt(origin));
      }),
      resume: (origin = internalOrigin(sessionId)) => Effect.gen(function* () {
        const next = yield* replacement();
        yield* (next === undefined ? enqueue("resume", "", origin) : next.resume(origin));
      }),
      restoreContext: (id) => Effect.gen(function* () {
        const next = yield* replacement();
        return yield* (next === undefined ? admission.restoreContextProjection(id) : next.restoreContext(id));
      }),
      get: (options = {}) => SessionHandleStore.getSnapshot(sessionId, options.turns ?? 1),
      watch: (options = {}) => SessionHandleStore.watchSnapshot(sessionId, options.turns ?? 1, runtime.observations),
      history: (request = {}) => SessionHandleStore.historyPage(sessionId, request),
      inspect: (request = {}) => inspectSession(sessionId, request),
      close: () => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        if (state.closed) return;
        if (state.released) return yield* releasedClose();
        // Durable cancellation precedes interruption. Shutdown never transfers a
        // live raw slot's fence, including the zero-grace case.
        yield* recordIngress("interrupt", "", internalOrigin(sessionId));
        state.closed = true;
        state.controller?.abort();
        const grace = runtime.closeGraceMs ?? SessionHandleStore.LEASE_TTL_MS;
        // Only the grace wait is interruptible: the timeout must be able to abandon a
        // still-pending raw slot while the surrounding shutdown stays uninterruptible.
        const completion = grace <= 0 ? Option.none<void>() : yield* restore(settleClose().pipe(Effect.timeoutOption(grace)));
        if (Option.isNone(completion)) yield* sealUnknown();
        yield* releaseAfterClose();
      })),
    };

    function recordIngress(kind: Inbox.Kind, content: string, origin: Inbox.Origin) {
      return Effect.gen(function* () {
        yield* SessionHandleStore.commitInbox({
          id: entropy(), sessionId, kind, content, origin, createdAt: clock(),
          parentActionId: SessionHandleStore.tree(sessionId).at(-1)?.id ?? null,
        });
        const current = SessionHandleStore.row(sessionId);
        // The durable interrupted mark needs this controller's live fence; under an
        // expired lease only the inbox row lands and the abort below still fires.
        if (kind !== "interrupt" || current.state !== "running" || !(leaseLive(current) && current.leaseOwner === owner)) return;
        yield* SessionHandleStore.commit({
          sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
          actions: [], consumeInboxIds: [], state: "interrupted", releaseLease: false,
        });
        state.controller?.abort();
      });
    }

    function enqueue(kind: Inbox.Kind, content: string, origin: Inbox.Origin) {
      return Effect.gen(function* () {
        if (state.closed) return yield* new ForeignFailure({ operation: "session.enqueue", cause: "closed" });
        const running = SessionHandleStore.row(sessionId).state === "running";
        yield* recordIngress(kind, content, origin);
        if (kind === "resume" && running) return undefined;
        return yield* reconcile();
      });
    }

    function reconcile(): Effect.Effect<SessionRunnerResult | undefined, SessionError> {
      return Effect.gen(function* () {
        if (SessionHandleStore.pendingInbox(sessionId).some((item) => item.kind === "interrupt")) state.controller?.abort();
        if (state.closed || state.released) return undefined;
        if (state.active === undefined) {
          state.active = yield* Effect.forkIn(driveAvailable().pipe(Effect.onExit(() => Effect.gen(function* () {
            state.active = undefined;
            yield* hibernate(SessionHandleStore.row(sessionId)).pipe(Effect.orDie);
          }))), scope);
        }
        return yield* Fiber.join(state.active);
      });
    }

    function driveInbox(pending: readonly Inbox.Row[]): Effect.Effect<{ readonly stop: boolean; readonly result?: SessionRunnerResult }, SessionError> {
      return Effect.gen(function* () {
        if (pending.length === 0) return { stop: true };
        if (SessionHandleStore.row(sessionId).state === "interrupted") {
          const resume = pending.find((item) => item.kind === "resume");
          if (resume === undefined) return { stop: true };
          return { stop: false, result: yield* admission.resumeInterrupted(resume) };
        }
        const firstPrompt = pending.findIndex((item) => item.kind === "prompt");
        if (firstPrompt === 0) return { stop: false, result: yield* admission.startTurn() };
        yield* admission.consumeNoopInbox(firstPrompt > 0 ? pending.slice(0, firstPrompt) : pending);
        return { stop: false };
      });
    }

    function driveAvailable(): Effect.Effect<SessionRunnerResult | undefined, SessionError> {
      return Effect.gen(function* () {
        let result: SessionRunnerResult | undefined;
        while (!state.closed) {
          if (SessionHandleStore.outboundRows(sessionId).some((item) => item.state === "pending")) {
            state.fence = yield* acquire(SessionHandleStore.row(sessionId).leaseFence);
            yield* dispatchSessionOutbound(sessionId, runtime, owner, state.fence, clock, pinPolicy, true);
          }
          const open = SessionHandleStore.openTurns(SessionHandleStore.tree(sessionId)).at(-1);
          if (open !== undefined) { result = yield* admission.resumeTurn(open); continue; }
          const next = yield* driveInbox(SessionHandleStore.pendingInbox(sessionId));
          if (next.stop) break;
          result = next.result ?? result;
        }
        return result;
      });
    }

    function awaitRetainedRunner(): Effect.Effect<void, SessionError> {
      return Effect.gen(function* () {
        if (state.retainedRunner !== undefined) yield* Fiber.join(state.retainedRunner);
        if (state.retainedFailure !== undefined) {
          const failure = state.retainedFailure;
          state.retainedFailure = undefined;
          return yield* Effect.fail(failure);
        }
      });
    }

    function hibernate(current: LedgerSession.Row): Effect.Effect<void, SessionError> {
      return Effect.suspend(() => {
        if (state.released || state.active !== undefined || state.rawSlots.pending() > 0 || leaseLive(current)) return Effect.void;
        if (!state.closed && SessionHandleStore.pendingInbox(sessionId).length > 0) return Effect.void;
        state.released = true;
        lifecycle.release();
        return runtime.onHibernate?.(sessionId) ?? Effect.void;
      });
    }

    function sealUnknown() {
      return Effect.gen(function* () {
        const actions = SessionHandleStore.tree(sessionId);
        const terminals = new Set(actions.filter((action) => isResult(action)).map((action) => action.parentId));
        const unresolved = actions.filter((action) => isPending(action) && !terminals.has(action.id));
        const pending: LedgerAction.Append[] = unresolved.map((action) => ({
          id: entropy(), parentId: action.id, sessionId, kind: action.kind,
          intent: { encodingVersion: 1, value: { phase: "result", op: "shutdown" } },
          effect: { encodingVersion: 1, value: { phase: "result", terminal: "outcome_unknown", reason: "shutdown_grace_exhausted" } },
          ts: clock(), irreversible: true,
        }));
        for (const open of SessionHandleStore.openTurns(actions)) pending.push(turnTerminalAction({
          id: open.resultId, parentId: pending.at(-1)?.id ?? actions.at(-1)?.id ?? open.action.id,
          sessionId, turnId: open.turnId, result: { kind: "interrupted" }, resumeCount: open.resumeCount,
          boundaryActionId: open.boundaryActionId, at: clock(),
        }));
        if (pending.length === 0) return;
        const current = SessionHandleStore.row(sessionId);
        yield* SessionHandleStore.commit({
          sessionId, owner, fence: state.fence, now: clock(), expectedRevision: current.revision,
          actions: pending, consumeInboxIds: [], state: "interrupted", releaseLease: false,
        });
        state.terminalFrozen = true;
      });
    }
    return { handle, owner, reconcile };
  });
}

function isPending(action: LedgerAction.Node): boolean {
  const value = action.effect.value;
  return value !== null && typeof value === "object" && !Array.isArray(value) && value.phase === "pending";
}
function isResult(action: LedgerAction.Node): boolean {
  const value = action.effect.value;
  return value !== null && typeof value === "object" && !Array.isArray(value) && value.phase === "result";
}
function defaultHeartbeat(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
