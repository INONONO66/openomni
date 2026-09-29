import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import type { LedgerSession } from "@openomni/protocol";
import { Effect } from "effect";
import { createObservationBus } from "../../src/observation/bus";
import type { RunnerServices } from "../../src/services";
import { runnerTestLayer } from "./service-layers";

/**
 * One isolation's handle-scoped ledger (W5.2 F1): a fresh in-memory session
 * store shared by every session the test declares plus a fresh catalog, with
 * one observation bus wired as the stores' commit sink so `watch` planes see
 * ActionCommitted events. `openKernel` serves every session from the shared
 * store — the per-session-file split is a production layout, not a kernel
 * contract, and agent tests exercise the kernel contract.
 */
export interface IsolatedLedger {
  readonly kernel: SessionHandleStore.SessionKernel;
  readonly openKernel: (sessionId: string) => SessionHandleStore.SessionKernel;
  readonly listSessions: () => LedgerSession.Row[];
  readonly session: ReturnType<typeof openSessionStore>;
  readonly catalog: ReturnType<typeof openCatalogStore>;
  readonly bus: ReturnType<typeof createObservationBus>;
}

export type IsolatedLedgerHandle = IsolatedLedger & { close: () => void };

function makeIsolatedLedger(): IsolatedLedgerHandle {
  const bus = createObservationBus();
  const session = openSessionStore(":memory:", bus);
  const catalog = openCatalogStore(":memory:", bus);
  const kernel = SessionHandleStore.createSessionKernel(session, catalog);
  return {
    kernel,
    openKernel: () => kernel,
    listSessions: () => kernel.listRows(),
    session,
    catalog,
    bus,
    close: () => {
      session.close();
      catalog.close();
    },
  };
}

let active: IsolatedLedger | undefined;
let chain: Promise<void> = Promise.resolve();

/** The isolation currently executing; helpers resolve their kernel lazily through this. */
export function isolatedLedger(): IsolatedLedger {
  if (active === undefined) throw new Error("isolatedLedger() is only available inside isolated()");
  return active;
}

type IsolatedProgram<A, E> = Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>;

/**
 * Runs one scoped Effect program against a fresh handle-scoped ledger; the
 * only test-side runner for agent programs. Concurrent calls serialize so the
 * lazy `isolatedLedger()` pointer always names exactly one isolation.
 * NEVER nest isolated() inside a running isolated program: the module-level
 * chain serializes all calls, so the inner call deadlocks the whole process.
 */
export function isolated<A, E>(
  program: IsolatedProgram<A, E> | ((ledger: IsolatedLedger) => IsolatedProgram<A, E>),
  makeLedger: () => IsolatedLedgerHandle = makeIsolatedLedger,
): Promise<A> {
  const run = async () => {
    const ledger = makeLedger();
    active = ledger;
    try {
      const effect = typeof program === "function" ? program(ledger) : program;
      return await Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runnerTestLayer))));
    } finally {
      active = undefined;
      ledger.close();
    }
  };
  const result = chain.then(run, run);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The isolation currently executing, if any; crash mains reuse it instead of nesting. */
export function activeIsolation(): IsolatedLedger | undefined {
  return active;
}

type IsolatedOutcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly thrown: Error };

/**
 * Promise-shaped isolation for imperative crash mains and matrix cells: the
 * same fresh-ledger contract as `isolated`, with thrown-error identity
 * preserved (no FiberFailure wrapping).
 */
export function isolatedRun<A>(
  fn: (ledger: IsolatedLedger) => Promise<A> | A,
  makeLedger: () => IsolatedLedgerHandle = makeIsolatedLedger,
): Promise<A> {
  return isolated<IsolatedOutcome<A>, never>(
    (ledger) =>
      Effect.promise(async (): Promise<IsolatedOutcome<A>> => {
        try {
          return { ok: true, value: await fn(ledger) };
        } catch (thrown) {
          return { ok: false, thrown: thrown instanceof Error ? thrown : new Error(String(thrown)) };
        }
      }),
    makeLedger,
  ).then((outcome) => {
    if (outcome.ok) return outcome.value;
    throw outcome.thrown;
  });
}
