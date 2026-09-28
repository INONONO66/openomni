import { Context, Effect, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";
import { appendTurnAction, ensureSessionRow, fileFor, openSessionDb } from "./session-file.ts";

/** Root directory holding one <sessionId>.sqlite ledger file per session. */
export class SessionRoot extends Context.Service<SessionRoot, string>()(
  "spike/w5-cluster/SessionRoot",
) {}

/** Single lease identity for the spike runner (fence work is another lane). */
export const SPIKE_OWNER = "spike-single-runner";
export const SPIKE_FENCE = 1;

export const PromptRpc = Rpc.make("Prompt", {
  payload: { text: Schema.String, delayMs: Schema.optional(Schema.Number) },
  success: Schema.Struct({ ordinal: Schema.Number, actionHash: Schema.String }),
}).annotate(ClusterSchema.Persisted, true);

export const SessionEntity = Entity.make("Session", [PromptRpc]);

/**
 * One entity activation per sessionId. Cluster is host + mailbox + clock only;
 * durability is OUR hash chain in the per-session sqlite file.
 */
export const SessionEntityLayer = SessionEntity.toLayer(
  Effect.gen(function* () {
    const root = yield* SessionRoot;
    const address = yield* Entity.CurrentAddress;
    const sessionId: string = address.entityId;
    const db = openSessionDb(fileFor(root, sessionId));
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
    ensureSessionRow(db, sessionId, SPIKE_OWNER, SPIKE_FENCE);
    return {
      Prompt: (envelope: Entity.Request<typeof PromptRpc>) =>
        Effect.sync(() => {
          const row = ensureSessionRow(db, sessionId, SPIKE_OWNER, SPIKE_FENCE);
          const result = appendTurnAction(db, {
            sessionId,
            owner: SPIKE_OWNER,
            fence: SPIKE_FENCE,
            expectedRevision: row.revision,
            payload: { text: envelope.payload.text },
          });
          return { ordinal: result.ordinal, actionHash: result.actionHash };
        }),
    };
  }),
);

/** Send one prompt to the Session entity for `sessionId` via the sharded client. */
export const sendPrompt = (sessionId: string, text: string) =>
  Effect.gen(function* () {
    const makeClient = yield* SessionEntity.client;
    return yield* makeClient(sessionId).Prompt({ text });
  });
