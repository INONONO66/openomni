import { join } from "node:path";
import type { ObservationSink } from "@openomni/protocol";
import { Effect, Layer } from "effect";
import { ForeignFailure } from "./errors";
import { LedgerWrites, type LedgerHandles } from "./services";
import { openCatalogStore } from "./storage/catalog-store.js";
import { openSessionStore } from "./storage/session-store.js";

/**
 * Composition-root ledger plane (W5.2 F1): opens the shared catalog file and
 * hands out per-session store openers under `<sessionsDir>/<id>.sqlite`. The
 * catalog closes with the layer scope; session stores close with whoever
 * opened them (entity activation finalizers).
 */
export function LedgerCatalogLive(options: {
  readonly catalogPath: string;
  readonly sessionsDir: string;
  readonly observationSink?: ObservationSink;
}): Layer.Layer<LedgerWrites, ForeignFailure> {
  return Layer.effect(
    LedgerWrites,
    Effect.acquireRelease(
      Effect.try({
        try: () => openCatalogStore(options.catalogPath, options.observationSink),
        catch: (cause) => new ForeignFailure({ operation: "ledger.open", cause: String(cause) }),
      }),
      (catalog) => Effect.sync(() => catalog.close()),
    ).pipe(
      Effect.map((catalog) => ({
        catalog,
        openSession: (sessionId: string) =>
          openSessionStore(
            join(options.sessionsDir, `${sessionId}.sqlite`),
            options.observationSink,
          ),
      })),
    ),
  );
}

/** Test/embedded composition over already-open handles; closing stays with the caller. */
export function LedgerLive(handles: LedgerHandles): Layer.Layer<LedgerWrites> {
  return Layer.succeed(LedgerWrites, handles);
}
