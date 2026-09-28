import type { Database } from "bun:sqlite";
import { join } from "node:path";
// Public ledger surface: SqliteStorageAdapter owns the schema (runs the full
// sqlite bootstrap/migrations in its constructor).
import { SqliteStorageAdapter, type LedgerError } from "@openomni/ledger";
import { LedgerSession, type PlainValue } from "@openomni/protocol";
// SPIKE-ONLY deep import: commitSession/insertSession/selectSession are not on
// the @openomni/ledger public surface (only exports "." in package.json), so we
// reach into the source relatively. Never do this outside the spike.
import {
  commitSession,
  insertSession,
  selectSession,
} from "../../../packages/ledger/src/storage/sqlite-l0-write";

/** Far-future lease expiry (2100-01-01T00:00:00Z) for spike-held leases. */
export const SPIKE_LEASE_EXPIRES_AT = 4102444800000;

export function fileFor(root: string, sessionId: string): string {
  return join(root, `${sessionId}.sqlite`);
}

/**
 * Open (and bootstrap, when fresh) a per-session ledger sqlite file. The
 * ledger's SqliteStorageAdapter is the schema owner; we only borrow its
 * Database handle. `initialize()` from the ledger is a process-global
 * singleton keyed to ONE dbPath, so per-session files must construct the
 * adapter directly instead.
 */
export function openSessionDb(path: string): Database {
  return new SqliteStorageAdapter(path).testDatabase();
}

/** Insert the session row if missing; returns the current row either way. */
export function ensureSessionRow(
  db: Database,
  sessionId: string,
  owner: string,
  fence: number,
): LedgerSession.Row {
  const existing = selectSession(db, sessionId);
  if (existing !== undefined) return existing;
  insertSession(
    db,
    LedgerSession.Row.parse({
      id: sessionId,
      parentId: null,
      role: "resident",
      leaseOwner: owner,
      leaseFence: fence,
      leaseExpiresAt: SPIKE_LEASE_EXPIRES_AT,
      revision: 0,
      state: "idle",
      toolsGeneration: 0,
      systemHash: "",
      policyGeneration: 0,
    }),
  );
  const inserted = selectSession(db, sessionId);
  if (inserted === undefined) {
    throw new Error(`session row missing after insert: ${sessionId}`);
  }
  return inserted;
}

export interface AppendTurnInput {
  readonly sessionId: string;
  readonly owner: string;
  readonly fence: number;
  readonly expectedRevision: number;
  readonly payload: PlainValue;
}

export interface AppendTurnResult {
  readonly ordinal: number;
  readonly prevHash: string;
  readonly actionHash: string;
  readonly revision: number;
}

const refuse = (error: LedgerError): never => {
  throw error;
};

/**
 * Append one action to OUR hash chain through the ledger's commitSession
 * (lease fence + CAS revision + prev_hash/action_hash all enforced there).
 */
export function appendTurnAction(db: Database, input: AppendTurnInput): AppendTurnResult {
  const now = Date.now();
  const request = LedgerSession.Commit.parse({
    sessionId: input.sessionId,
    owner: input.owner,
    fence: input.fence,
    now,
    expectedRevision: input.expectedRevision,
    actions: [
      {
        id: crypto.randomUUID(),
        parentId: null,
        sessionId: input.sessionId,
        kind: "prompt",
        intent: { encodingVersion: 1, value: input.payload },
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
  if (result === undefined) {
    throw new Error(`commitSession: session not found: ${input.sessionId}`);
  }
  if (!result.ok) {
    throw new Error(
      `commitSession refused (${result.reason}): fence=${result.currentFence} revision=${result.currentRevision}`,
    );
  }
  const receipt = result.receipts[0];
  if (receipt === undefined) {
    throw new Error(`commitSession returned no receipt: ${input.sessionId}`);
  }
  return {
    ordinal: receipt.action.ordinal,
    prevHash: receipt.action.prevHash,
    actionHash: receipt.action.actionHash,
    revision: result.row.revision,
  };
}

export interface ChainRow {
  readonly ordinal: number;
  readonly prev_hash: string;
  readonly action_hash: string;
}

export function readChain(db: Database, sessionId: string): ChainRow[] {
  return db
    .query<ChainRow, [string]>(
      "SELECT ordinal, prev_hash, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
    )
    .all(sessionId);
}
