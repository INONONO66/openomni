import { Kernel, Session, type Journal } from "@openomni/agent";
const adoptSessionAuthority = Session.adoptSessionAuthority;
const createSessionEntityRunTurn = Session.createSessionEntityRunTurn;
const decideSessionAdmission = Session.decideSessionAdmission;
const Entropy = Kernel.Entropy;
const AgentFailure = Kernel.AgentFailure;
const GenerationLayers = Kernel.GenerationLayers;
const ObservationSink = Kernel.ObservationSink;
type SessionEntryServices = Kernel.SessionEntryServices;
type SessionError = Kernel.SessionError;
type SessionRuntime = Session.SessionRuntime;
type LedgerError = Journal.LedgerError;
import type { SessionTurn } from "@openomni/protocol";
import { Clock, Context, Effect, type Scope } from "effect";
import {
  AppLedger,
  createAppLedger,
  type AppLedgerPlane,
  type SessionKernel,
} from "../../src/composition/cluster-runtime";
import { localInboxCommit } from "../../src/process-entry";
import type { AppRuntime } from "../../src/runtime";
import { runRuntimeEffect } from "./effect";
import { testClock } from "./test-entropy";

/** A standalone app ledger plane for fixtures that never boot the runtime. */
export function testPlane(
  options: Partial<Parameters<typeof createAppLedger>[0]> = {},
): AppLedgerPlane {
  return createAppLedger({ ...options, now: options.now ?? testClock() });
}

/** The booted runtime's own plane — the one the entity and boot share. */
export function planeOf(runtime: AppRuntime): Promise<AppLedgerPlane> {
  return runRuntimeEffect(runtime, Effect.map(AppLedger, (plane) => plane));
}

/** Strictly-newer fence adoption on a fixture kernel (the entity's own CAS). */
export function adoptTestFence(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): Effect.Effect<number, LedgerError> {
  return adoptSessionAuthority(kernel, sessionId, owner);
}

/**
 * A cluster-free inbox commit for fixtures: the process child's own local
 * delivery (src/process-entry.ts), bound to a fixture plane and owner.
 */
export function localInbox(
  plane: AppLedgerPlane,
  owner = "test-inbox",
  clock: () => number = () => Date.now(),
) {
  return localInboxCommit(plane, owner, clock);
}

export type ResolvedTestRuntime = Parameters<typeof createSessionEntityRunTurn>[1];

/** The app's runtime resolution, replayed for fixtures over a built service context. */
export function resolvedRuntimeFor(
  runtime: SessionRuntime,
  context: Context.Context<SessionEntryServices>,
): ResolvedTestRuntime {
  return {
    ...runtime,
    clock: Context.get(context, Clock.Clock).currentTimeMillisUnsafe,
    entropy: Context.get(context, Entropy).id,
    observations: Context.get(context, ObservationSink),
    generations: Context.get(context, GenerationLayers),
    services: context,
  };
}

/**
 * The entity's backlog drain, minus the mailbox (mirrors the process child):
 * adopt the fence once, then run admitted decisions until the chain says
 * stop. Returns the latest turn terminal the drain settled.
 */
export function drainSession(deps: {
  readonly plane: AppLedgerPlane;
  readonly sessionId: string;
  readonly runner: Parameters<typeof createSessionEntityRunTurn>[0];
  readonly runtime: ResolvedTestRuntime;
  readonly scope: Scope.Scope;
  readonly owner?: string;
}): Effect.Effect<SessionTurn.Terminal | undefined, SessionError | LedgerError> {
  const owner = deps.owner ?? "test-drain";
  const kernel = deps.plane.openKernel(deps.sessionId);
  const runTurn = createSessionEntityRunTurn(deps.runner, deps.runtime, deps.scope);
  return Effect.gen(function* () {
    const fence = yield* adoptTestFence(kernel, deps.sessionId, owner);
    const authority = { sessionId: deps.sessionId, owner, fence };
    for (;;) {
      const row = kernel.row(deps.sessionId);
      const open = kernel.latestOpenTurn(deps.sessionId);
      const terminal = kernel.latestTurnTerminal(deps.sessionId);
      const snapshot = {
        row,
        pending: kernel.pendingMessages(deps.sessionId),
        ...(open === undefined ? {} : { open }),
        ...(terminal === undefined ? {} : { terminal }),
      };
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
          return kernel.latestTurnTerminal(deps.sessionId)?.effect;
        case "refused":
          return yield* new AgentFailure({ operation: "session.admission", cause: "invalid_state" });
        case "consume":
          // The consume fold is entity-owned; a fixture reaching it is a
          // wiring defect, not backlog to silently drop.
          return yield* new AgentFailure({ operation: "session.admission", cause: "consume_in_fixture" });
        case "start":
          // Inline detach: this drain owns the whole turn's lifetime itself.
          yield* runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach: (body) => body });
          continue;
        default:
          yield* runTurn({ authority, kernel, decision, snapshot, detach: (body) => body });
          continue;
      }
    }
  });
}
