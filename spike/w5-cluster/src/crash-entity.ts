import type { Database } from "bun:sqlite";
import { Context, DateTime, Deferred, Duration, Effect, Layer, Schema } from "effect";
import { ClusterSchema, DeliverAt, Entity, SingleRunner } from "effect/cluster";
import { Rpc } from "effect/rpc";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { LedgerSession } from "@openomni/protocol";
import type { LedgerError } from "@openomni/ledger";
// SPIKE-ONLY deep import (same precedent as session-file.ts): commitSession is
// not on the @openomni/ledger public surface.
import { commitSession } from "../../../packages/ledger/src/storage/sqlite-l0-write";
import { BunCrypto } from "./crypto.ts";
import { SessionRoot, SPIKE_FENCE, SPIKE_OWNER } from "./session-entity.ts";
import { ensureSessionRow, fileFor, openSessionDb } from "./session-file.ts";

/** One handled (appended or deduped) turn, reported synchronously by the entity handler. */
export interface HandledEvent {
  readonly turnId: string;
  readonly ordinal: number;
  readonly actionHash: string;
  readonly deduped: boolean;
  readonly at: number;
}

export interface CrashHooksService {
  /** "crash": handler appends then blocks forever (message stays unprocessed). */
  readonly mode: "crash" | "restart";
  readonly onHandled: (event: HandledEvent) => void;
}

export class CrashHooks extends Context.Service<CrashHooks, CrashHooksService>()(
  "spike/w5-cluster/CrashHooks",
) {}

const TurnSuccess = Schema.Struct({
  ordinal: Schema.Number,
  actionHash: Schema.String,
  deduped: Schema.Boolean,
});

export const TurnRpc = Rpc.make("Turn", {
  payload: { turnId: Schema.String, text: Schema.String },
  success: TurnSuccess,
}).annotate(ClusterSchema.Persisted, true);

/**
 * Payload implementing the DeliverAt protocol: the cluster mailbox must not
 * hand this message to the entity before `deliverAtMs`.
 */
export class ScheduledPayload extends Schema.Class<ScheduledPayload>(
  "spike/w5-cluster/ScheduledPayload",
)({
  turnId: Schema.String,
  text: Schema.String,
  deliverAtMs: Schema.Number,
}) {
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.deliverAtMs);
  }
}

export const ScheduledRpc = Rpc.make("Scheduled", {
  payload: ScheduledPayload,
  success: TurnSuccess,
}).annotate(ClusterSchema.Persisted, true);

export const CrashEntity = Entity.make("CrashSession", [TurnRpc, ScheduledRpc]);

const refuse = (error: LedgerError): never => {
  throw error;
};

export interface AppendOutcome {
  readonly ordinal: number;
  readonly actionHash: string;
  readonly deduped: boolean;
}

/**
 * Idempotent append keyed by OUR chain's turn id (action.id === turnId): a
 * redelivered cluster message whose first append already committed must not
 * produce a duplicate chain row.
 */
export function appendTurnIdempotent(
  db: Database,
  sessionId: string,
  turnId: string,
  text: string,
): AppendOutcome {
  const existing = db
    .query<{ ordinal: number; action_hash: string }, [string, string]>(
      "SELECT ordinal, action_hash FROM action WHERE session_id = ? AND id = ?",
    )
    .get(sessionId, turnId);
  if (existing !== null) {
    return { ordinal: existing.ordinal, actionHash: existing.action_hash, deduped: true };
  }
  const row = ensureSessionRow(db, sessionId, SPIKE_OWNER, SPIKE_FENCE);
  const now = Date.now();
  const request = LedgerSession.Commit.parse({
    sessionId,
    owner: SPIKE_OWNER,
    fence: SPIKE_FENCE,
    now,
    expectedRevision: row.revision,
    actions: [
      {
        id: turnId,
        parentId: null,
        sessionId,
        kind: "prompt",
        intent: { encodingVersion: 1, value: { text } },
        effect: { encodingVersion: 1, value: null },
        ts: now,
        irreversible: true,
      },
    ],
    consumeInboxIds: [],
    state: "idle",
    releaseLease: false,
  });
  const result = db.transaction(() => commitSession(db, request, refuse)).immediate();
  if (result === undefined) throw new Error(`commitSession: session not found: ${sessionId}`);
  if (!result.ok) {
    throw new Error(
      `commitSession refused (${result.reason}): fence=${result.currentFence} revision=${result.currentRevision}`,
    );
  }
  const receipt = result.receipts[0];
  if (receipt === undefined) throw new Error(`commitSession returned no receipt: ${sessionId}`);
  return {
    ordinal: receipt.action.ordinal,
    actionHash: receipt.action.actionHash,
    deduped: false,
  };
}

/**
 * Crash-matrix flavor of the Session entity: in "crash" mode the handler
 * appends action 1, reports it, then blocks on a Deferred that is never
 * resolved so the mailbox row stays unprocessed until SIGKILL.
 */
export const CrashEntityLayer = CrashEntity.toLayer(
  Effect.gen(function* () {
    const root = yield* SessionRoot;
    const hooks = yield* CrashHooks;
    const address = yield* Entity.CurrentAddress;
    const sessionId: string = address.entityId;
    const db = openSessionDb(fileFor(root, sessionId));
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    ensureSessionRow(db, sessionId, SPIKE_OWNER, SPIKE_FENCE);
    const handle = (turnId: string, text: string) =>
      Effect.gen(function* () {
        const outcome = appendTurnIdempotent(db, sessionId, turnId, text);
        hooks.onHandled({ ...outcome, turnId, at: Date.now() });
        if (hooks.mode === "crash") {
          const never = yield* Deferred.make<void>();
          yield* Deferred.await(never); // never resolved: message stays unacknowledged
        }
        return outcome;
      });
    return {
      Turn: (envelope: Entity.Request<typeof TurnRpc>) =>
        handle(envelope.payload.turnId, envelope.payload.text),
      Scheduled: (envelope: Entity.Request<typeof ScheduledRpc>) =>
        handle(envelope.payload.turnId, envelope.payload.text),
    };
  }),
);

export interface CrashRuntimeOptions {
  readonly root: string;
  readonly catalogFile: string;
  readonly hooks: CrashHooksService;
}

/** Same single-node topology as makeRuntime, but hosting the crash entity. */
export function makeCrashRuntime(options: CrashRuntimeOptions) {
  const SqlLive = SqliteClient.layer({ filename: options.catalogFile });
  const ClusterLive = SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMaxIdleTime: Duration.seconds(10),
      entityMessagePollInterval: Duration.millis(100),
    },
  }).pipe(Layer.provide(SqlLive), Layer.provide(BunCrypto));
  return CrashEntityLayer.pipe(
    Layer.provide(Layer.succeed(SessionRoot, options.root)),
    Layer.provide(Layer.succeed(CrashHooks, options.hooks)),
    Layer.provideMerge(ClusterLive),
  );
}

export const sendTurn = (sessionId: string, turnId: string, text: string) =>
  Effect.gen(function* () {
    const makeClient = yield* CrashEntity.client;
    return yield* makeClient(sessionId).Turn({ turnId, text });
  });

export const sendScheduled = (
  sessionId: string,
  turnId: string,
  text: string,
  deliverAtMs: number,
) =>
  Effect.gen(function* () {
    const makeClient = yield* CrashEntity.client;
    return yield* makeClient(sessionId).Scheduled({ turnId, text, deliverAtMs });
  });
