import { Ledger, type Storage as ProtocolStorage } from "@openomni/protocol";
import { isSqliteBusyError } from "./sqlite-busy.js";

/**
 * Single owner of decision-class COMMIT MECHANICS (#510; semantic-audit
 * sem-lifecycle.md section 4). WorkItem, Wait, and Engagement each used to
 * spell this sequence themselves:
 *
 *   1. append the decision fact to the owner stream at
 *      `expectedHead = the pre-transition revision`;
 *   2. on a stale head that is EMPTY while the projection sits at revision
 *      >= 1, adopt the stream at the observed revision and retry the append
 *      once (the pre-cutover row path);
 *   3. land the projection under a revision compare-and-set;
 *   4. commit 1-3 inside ONE sync immediate storage transaction, so a
 *      projection failure rolls the appended fact back and `ledger_head.head`
 *      always equals the committed row's `revision`;
 *   5. map a SQLITE_BUSY at the transaction entry to the caller's typed
 *      "nothing committed" error.
 *
 * What deliberately stays with each domain, per the audit's do-not-touch
 * ruling: the state machine (the fold), typed fact construction, the conflict
 * error TAXONOMY, and the adoption GENESIS payload. Engagement has no
 * adoption path at all (its stream class was born with the table); Wait
 * adopts identity fields only, for erasability; WorkItem adopts a full
 * snapshot. Those are persisted-fact baselines, not mechanics, so the
 * coordinator takes the genesis as an input and never invents one.
 *
 * This module owns ordering. It does not own meaning.
 */

/** A decision-class fact: its stream type plus the payload the domain built. */
type CommitFact = Readonly<{ type: string; data: Record<string, unknown> }>;

/**
 * Lazy stream adoption for a pre-cutover projection row: a row at revision
 * >= 1 whose owner stream is EMPTY, because its writes predate the fact
 * cutover. The genesis lands at `seq === revision`, then the real append
 * retries at the same head. Domains that cannot have pre-cutover rows omit
 * this entirely and a stale empty head stays a conflict.
 */
type CommitAdoption = Readonly<{
  /** Genesis fact recorded at `seq === expectedHead`. Domain-owned payload. */
  genesis: Ledger.AdoptGenesis;
}>;

export type CommitRequest = Readonly<{
  /** Owner stream for this resource, e.g. `wait:<id>` or `work:<hash>`. */
  streamId: string;
  /** The projection's revision BEFORE this transition. */
  expectedHead: number;
  fact: CommitFact;
  /** Absent when the domain has no pre-cutover rows. */
  adoption?: CommitAdoption;
}>;

/**
 * Why a commit did not happen. `stale_head` covers every lost race: a
 * concurrent writer advanced the stream, the projection CAS was beaten, or a
 * concurrent adopter won the genesis. All three leave nothing written and are
 * retriable from the fresh head, which is the CALLER's decision.
 */
type CommitRefusal = Readonly<{ kind: "stale_head" }>;

export type CommitOutcome<T> = Readonly<{ kind: "committed"; value: T }> | CommitRefusal;

/**
 * Appends `request.fact` at the expected head and lands the caller's
 * projection write in the same unit.
 *
 * `project` runs only after the fact is appended, and its `false` return means
 * "the projection compare-and-set lost". A refusal is ATOMIC: append and
 * projection share a NESTED transaction (a savepoint on the caller's
 * transaction), and a lost projection unwinds that savepoint, so
 * `ledger_head.head` never outruns the projected revision. `project` MUST be a
 * compare-and-set against `expectedHead`; a blind write would defeat the
 * binding.
 *
 * The savepoint is what makes the refusal atomic for EVERY caller, not just
 * throwing ones. The completion writer reports a lost race by RETURNING false,
 * which COMMITS its transaction — leaning on the outer rollback would strand
 * the appended fact above the row's revision on exactly that path.
 *
 * MUST be called inside {@link runCommitTransaction}.
 */
export function commitFact<T>(
  ledger: ProtocolStorage.LedgerSubAdapter,
  request: CommitRequest,
  project: () => T | false,
  /**
   * Nested-transaction factory (the storage adapter's own `transaction`).
   * Omit it only where the caller has already bound append and projection
   * into one unit by other means.
   */
  nest?: <R>(unit: () => R) => R,
): CommitOutcome<T> {
  const event = {
    streamId: request.streamId,
    type: request.fact.type,
    data: request.fact.data,
  };

  const commit = (): CommitOutcome<T> => {
    let appended = ledger.append(event, request.expectedHead);
    const adoption = request.adoption;
    if (adoption !== undefined && isPreCutoverHead(appended, request.expectedHead)) {
      if (!adoptStream(ledger, request, adoption)) return { kind: "stale_head" };
      appended = ledger.append(event, request.expectedHead);
    }
    if (appended.kind === "cas_conflict") return { kind: "stale_head" };

    const projected = project();
    if (projected === false) return { kind: "stale_head" };
    return { kind: "committed", value: projected };
  };

  if (!nest) return commit();

  // A refusal must discard the append, but the CALLER's transaction may still
  // be committing (a writer that returns false rather than throwing). Throw
  // the refusal across the savepoint boundary to unwind just this unit, then
  // hand it back as an ordinary value.
  try {
    return nest(() => {
      const outcome = commit();
      if (outcome.kind !== "committed") throw new CommitRefused();
      return outcome;
    });
  } catch (error) {
    if (error instanceof CommitRefused) return { kind: "stale_head" };
    throw error;
  }
}

/** Internal savepoint-unwind signal; never escapes {@link commitFact}. */
class CommitRefused extends Error {
  constructor() {
    super("commit refused");
    this.name = "CommitRefused";
  }
}

/**
 * The pre-cutover signature: an EMPTY stream under a projection that already
 * has revisions. Any other stale head is a genuine lost race.
 */
function isPreCutoverHead(appended: Ledger.Outcome, expectedHead: number): boolean {
  return appended.kind === "cas_conflict" && appended.currentHead === 0 && expectedHead >= 1;
}

/** Returns false when a concurrent adopter won; every other error propagates. */
function adoptStream(
  ledger: ProtocolStorage.LedgerSubAdapter,
  request: CommitRequest,
  adoption: CommitAdoption,
): boolean {
  try {
    ledger.adoptStream(request.streamId, request.expectedHead, adoption.genesis);
    return true;
  } catch (error) {
    // A concurrent adopter surfaces as the typed AdoptError, which is the
    // same lost race any stale head produces.
    if (Ledger.AdoptError.isInstance(error)) return false;
    throw error;
  }
}

/**
 * Storage transaction entry for a decision-class write. A SQLITE_BUSY at
 * BEGIN IMMEDIATE (or inside the body) means NOTHING committed, so it maps to
 * the domain's own typed "unavailable" error via `onUnavailable` — callers
 * branch on their taxonomy, never on driver message text. Every other error
 * propagates unchanged.
 */
export function runCommitTransaction<T>(
  storage: Readonly<{ transaction<R>(operation: () => R): R }>,
  write: () => T,
  onUnavailable: (cause: unknown) => Error,
): T {
  try {
    return storage.transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) throw onUnavailable(error);
    throw error;
  }
}
