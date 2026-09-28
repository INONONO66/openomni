/**
 * Check-2 crash child. Usage:
 *   bun src/crash-child.ts <root> <catalogFile> <sessionId> crash|restart
 *
 * crash:   boots the runtime, sends Prompt turn-1; the handler appends chain
 *          action 1, prints "APPENDED 1 ..." and then blocks on a Deferred that
 *          is never resolved, leaving the cluster_messages row unprocessed.
 *          The parent SIGKILLs this process after reading the marker.
 * restart: boots the runtime on the SAME files, waits for the redelivered
 *          turn-1 (must dedupe against our chain), verifies the hash chain,
 *          commits + hydrates a fold checkpoint, then sends a DeliverAt
 *          message (now+1500ms) and reports the residual delay.
 */
import { Database } from "bun:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { initialize, SessionHandleStore } from "@openomni/ledger";
import { LedgerSession } from "@openomni/protocol";
// SPIKE-ONLY deep imports (same precedent as session-file.ts / check1 test).
import {
  computeActionHash,
  GENESIS_PREV_HASH,
} from "../../../packages/ledger/src/storage/l0-hash";
import { hydrateSessionHistory } from "../../../packages/agent/src/session-lifecycle/history";
import { foldCheckpointAction } from "../../../packages/agent/src/session-record";
import { SPIKE_FENCE, SPIKE_OWNER } from "./session-entity.ts";
import { fileFor } from "./session-file.ts";
import {
  makeCrashRuntime,
  sendScheduled,
  sendTurn,
  type CrashHooksService,
  type HandledEvent,
} from "./crash-entity.ts";

interface RawActionRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly session_id: string;
  readonly kind: string;
  readonly intent: string;
  readonly effect: string;
  readonly revert: string | null;
  readonly irreversible: 0 | 1;
  readonly encoding_version: number;
  readonly ts: number;
  readonly ordinal: number;
  readonly prev_hash: string;
  readonly action_hash: string;
}

/** Recompute every action_hash + prev_hash link from raw rows; returns row count. */
function verifyChain(sessionFile: string, sessionId: string): number {
  const db = new Database(sessionFile, { readonly: true });
  try {
    const rows = db
      .query<RawActionRow, [string]>(
        "SELECT id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal, prev_hash, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId);
    let prev = GENESIS_PREV_HASH;
    rows.forEach((row, index) => {
      if (row.ordinal !== index + 1) {
        throw new Error(`chain gap: expected ordinal ${index + 1}, got ${row.ordinal}`);
      }
      if (row.prev_hash !== prev) {
        throw new Error(`prev_hash link broken at ordinal ${row.ordinal}`);
      }
      const { action_hash, ...rest } = row;
      const recomputed = computeActionHash(rest);
      if (recomputed !== action_hash) {
        throw new Error(`action_hash mismatch at ordinal ${row.ordinal}: recomputed ${recomputed}`);
      }
      prev = action_hash;
    });
    return rows.length;
  } finally {
    db.close();
  }
}

const [root, catalogFile, sessionId, mode] = process.argv.slice(2);
if (
  root === undefined ||
  catalogFile === undefined ||
  sessionId === undefined ||
  (mode !== "crash" && mode !== "restart")
) {
  console.error("usage: bun src/crash-child.ts <root> <catalogFile> <sessionId> crash|restart");
  process.exit(2);
}

if (mode === "crash") {
  const hooks: CrashHooksService = {
    mode,
    onHandled: (event) => {
      console.log(
        `APPENDED ${event.ordinal} turn=${event.turnId} deduped=${event.deduped} action_hash=${event.actionHash} at=${event.at}`,
      );
    },
  };
  const runtime = ManagedRuntime.make(makeCrashRuntime({ root, catalogFile, hooks }));
  // The reply never arrives (the handler blocks forever); keep the process
  // alive until the parent SIGKILLs it.
  void runtime.runPromise(sendTurn(sessionId, "turn-1", "turn-1")).catch(() => undefined);
  await new Promise<never>(() => undefined);
} else {
  const events: HandledEvent[] = [];
  const waiters = new Map<string, (event: HandledEvent) => void>();
  const waitFor = (turnId: string, timeoutMs: number): Promise<HandledEvent> => {
    const already = events.find((event) => event.turnId === turnId);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise<HandledEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for handled event: ${turnId}`)),
        timeoutMs,
      );
      waiters.set(turnId, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  };
  const hooks: CrashHooksService = {
    mode,
    onHandled: (event) => {
      events.push(event);
      waiters.get(event.turnId)?.(event);
    },
  };
  const runtime = ManagedRuntime.make(makeCrashRuntime({ root, catalogFile, hooks }));
  await runtime.runPromise(Effect.void); // force layer build: sharding + entity live

  // 1. The unacknowledged mailbox row from the crashed process is redelivered.
  const redelivered = await waitFor("turn-1", 30_000);
  console.log(
    `REDELIVERED ${redelivered.ordinal} deduped=${redelivered.deduped} action_hash=${redelivered.actionHash} at=${redelivered.at}`,
  );

  // 2. Our chain survived intact (recomputed hashes + links).
  const sessionFile = fileFor(root, sessionId);
  console.log(`CHAIN_OK ${verifyChain(sessionFile, sessionId)}`);

  // 3. Fold checkpoint: commit one onto OUR chain, then hydrate from it.
  initialize({ dbPath: sessionFile });
  const before = hydrateSessionHistory(sessionId);
  const parentId = SessionHandleStore.latestAction(sessionId)?.id ?? null;
  const checkpoint = foldCheckpointAction({
    sessionId,
    parentId,
    revision: before.revision,
    at: Date.now(),
    reason: "interval",
    state: before.state,
  });
  await Effect.runPromise(
    SessionHandleStore.commit(
      LedgerSession.Commit.parse({
        sessionId,
        owner: SPIKE_OWNER,
        fence: SPIKE_FENCE,
        now: Date.now(),
        expectedRevision: before.revision,
        actions: [checkpoint],
        consumeInboxIds: [],
        state: "idle",
        releaseLease: false,
      }),
    ),
  );
  const hydrated = hydrateSessionHistory(sessionId);
  console.log(
    `CHECKPOINT_HYDRATED revision=${hydrated.revision} nonCheckpointActions=${hydrated.nonCheckpointActions} history=${hydrated.history.length}`,
  );

  // 4. DeliverAt: schedule turn-2 at now+1500ms; the residual must elapse.
  const tSend = Date.now();
  const deliverAtMs = tSend + 1500;
  const pending = waitFor("turn-2", 30_000);
  await runtime.runPromise(sendScheduled(sessionId, "turn-2", "turn-2", deliverAtMs));
  const handled = await pending;
  console.log(
    `DELIVER_AT residual_ms=${handled.at - tSend} t_send=${tSend} deliver_at=${deliverAtMs} t_handled=${handled.at}`,
  );

  // 5. Final chain: prompt(turn-1) + fold.checkpoint + prompt(turn-2).
  console.log(`CHAIN_OK ${verifyChain(sessionFile, sessionId)}`);
  const final = hydrateSessionHistory(sessionId);
  console.log(
    `HYDRATED_FINAL revision=${final.revision} nonCheckpointActions=${final.nonCheckpointActions} history=${final.history.length}`,
  );

  await runtime.dispose();
  process.exit(0);
}
