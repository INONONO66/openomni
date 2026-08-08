import { Database } from "bun:sqlite";
import type { LedgerAppend } from "@openomni/protocol";
import { Ledger } from "../../src/ledger-core/index";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";

/**
 * Shared ledger-core fixture builders for session tests: an in-memory
 * database initialized through the real migration runner (so the tests run
 * against the applied 0013_ledger DDL, not a re-declared schema).
 */
export function openLedgerDatabase(): Database {
  const db = new Database(":memory:");
  initializeSqliteDatabase(db);
  return db;
}

export function buildAppendInput(overrides: Partial<LedgerAppend.Input> = {}): LedgerAppend.Input {
  return {
    streamId: "stream-1",
    type: "decision.recorded",
    data: { note: "fixture", value: 1 },
    timeCreated: 1_000,
    ...overrides,
  };
}

/** Appends `count` chained fixture events to one stream; fails on any conflict. */
export function appendChain(
  db: Database,
  count: number,
  streamId = "stream-1",
): Extract<LedgerAppend.Outcome, { kind: "appended" }>[] {
  const outcomes: Extract<LedgerAppend.Outcome, { kind: "appended" }>[] = [];
  for (let head = 0; head < count; head += 1) {
    const outcome = Ledger.append(
      db,
      buildAppendInput({
        streamId,
        timeCreated: 1_000 + head,
        data: { note: "fixture", value: head },
      }),
      head,
    );
    if (outcome.kind !== "appended") {
      throw new Error(`fixture appendChain hit ${outcome.kind} at head ${head}`);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Runs fn and returns the Error it throws; fails when none is thrown. */
export function captureThrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got ${typeof error}`);
  }
  throw new Error("expected an Error, but nothing was thrown");
}
