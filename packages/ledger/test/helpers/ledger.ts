import { Database } from "bun:sqlite";
import type { Ledger as LedgerTypes, PlainValue } from "@openomni/protocol";

interface FixtureInput {
  streamId: string;
  type: string;
  data: Record<string, PlainValue>;
  timeCreated?: number;
}
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

export function buildAppendInput(overrides: Partial<FixtureInput> = {}): FixtureInput {
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
): Extract<LedgerTypes.Outcome, { kind: "appended" }>[] {
  const outcomes: Extract<LedgerTypes.Outcome, { kind: "appended" }>[] = [];
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
