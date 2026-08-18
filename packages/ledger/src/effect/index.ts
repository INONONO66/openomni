import { Ledger, type Storage as ProtocolStorage } from "@openomni/protocol";
import { isSqliteBusyError } from "../storage/sqlite-busy.js";
import { Storage } from "../storage/storage.js";

/**
 * #492 — the durable effect ledger. Wires the effect class that #510 shipped
 * as dormant vocabulary: every effect is a decision-class stream
 * `effect:<effectId>` where the intent event id IS the idempotency key. The
 * normative sequence is
 *
 *   intent(pending, seq 1) -> idempotent effect -> confirmed | failed (seq 2)
 *
 * — the intent lands FIRST (no record, no action), then EXACTLY ONE terminal
 * outcome fact. A crash between intent and outcome leaves the stream
 * outcome-less; {@link EffectStore.outstandingIntents} surfaces it under the
 * same effectId key so the reconciler probes the external world instead of
 * re-issuing (fold is authoritative for internal state; the external world is
 * eventually consistent via reconciliation, never 2PC).
 *
 * "unknown" is deliberately NOT a fact: it is a transient runtime status the
 * driver returns when it cannot yet prove confirmed vs failed. No terminal
 * fact is recorded, so the intent stays outcome-less and reconcilable —
 * confirmed/failed are the only terminal outcomes. `materializationCount` is
 * the count of terminal outcome facts on the stream: 0 while pending/unknown,
 * 1 once terminal.
 */
export class EffectStoreError extends Error {
  readonly name = "EffectStoreError";

  constructor(
    readonly code:
      | "adapter_absent"
      | "unavailable"
      | "not_intended"
      | "already_terminal"
      | "corrupt",
    message: string,
    readonly effectId?: string,
  ) {
    super(message);
  }
}

// Durable effect writes fail closed: a missing ledger sub-adapter is a typed
// error, never warn-and-continue — the intent must be recorded before the act.
function requireLedger(): ProtocolStorage.LedgerSubAdapter {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new EffectStoreError(
      "adapter_absent",
      "Storage adapter does not implement ledger append — durable effect writes fail closed",
    );
  }
  return ledger;
}

function effectStreamId(effectId: string): string {
  return `effect:${effectId}`;
}

/**
 * Store transaction entry: a SQLITE_BUSY at the write unit (see
 * storage/sqlite-busy.ts) means nothing committed — mapped to the typed
 * `unavailable` error so callers branch on the taxonomy, never on driver
 * message text. Every other error passes through unchanged.
 */
function runEffectTransaction<T>(effectId: string, write: () => T): T {
  try {
    return Storage.get().transaction(write);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw new EffectStoreError(
        "unavailable",
        `effect storage busy: ${effectId} — ${error instanceof Error ? error.message : String(error)}`,
        effectId,
      );
    }
    throw error;
  }
}

export namespace EffectStore {
  export type Status = "absent" | "pending" | "confirmed" | "failed";

  export type StatusView = Readonly<{
    effectId: string;
    status: Status;
    /** Terminal outcome facts on the stream: 0 while pending/absent, 1 once terminal. */
    materializationCount: number;
    receipt?: string;
    reason?: string;
  }>;

  export type IntendResult = Readonly<{
    intent: Ledger.EffectIntended;
    /** true when THIS call appended the intent; false on an idempotent replay of an existing intent. */
    fresh: boolean;
    status: StatusView;
  }>;

  /**
   * A terminal intent paired with its recorded outcome — the mirror of
   * {@link outstandingIntents}. Where that scan surfaces the outcome-LESS
   * intents for the driver to probe, this one surfaces the outcome-BEARING
   * intents so a consumer can re-project the already-recorded outcome onto a
   * read model that a crash between the terminal fact and its projection left
   * behind (#538). It NEVER terminalizes: both facts already exist.
   */
  export type TerminalIntent = Readonly<{
    intent: Ledger.EffectIntended;
    outcome: "confirmed" | "failed";
  }>;

  /**
   * Records the intent at seq 1 (record-before-act). A `cas_conflict` means
   * the effectId was already intended — the idempotency key hit — so this is
   * a replay: report the recorded status and `fresh: false` (the caller must
   * NOT blindly re-execute; a still-pending replay is the reconciler's job).
   */
  export function intend(input: Ledger.EffectIntended): IntendResult {
    const ledger = requireLedger();
    const intent = Ledger.EffectIntended.parse(input);
    const streamId = effectStreamId(intent.effectId);
    const appended = runEffectTransaction(intent.effectId, () =>
      ledger.append({ streamId, type: "effect.intended", data: { ...intent } }, 0),
    );
    if (appended.kind !== "cas_conflict") {
      return {
        intent,
        fresh: true,
        status: { effectId: intent.effectId, status: "pending", materializationCount: 0 },
      };
    }
    return { intent, fresh: false, status: status(intent.effectId) };
  }

  /** Records the definite success outcome at seq 2. Idempotent on replay of the same outcome. */
  export function confirm(effectId: string, receipt?: string): StatusView {
    return finalize(
      effectId,
      "effect.confirmed",
      Ledger.EffectConfirmed.parse({
        effectId,
        ...(receipt === undefined ? {} : { receipt }),
      }),
    );
  }

  /** Records the definite failure outcome at seq 2 (distinct from unknown). Idempotent on replay. */
  export function fail(effectId: string, reason: string): StatusView {
    return finalize(effectId, "effect.failed", Ledger.EffectFailed.parse({ effectId, reason }));
  }

  export function status(effectId: string): StatusView {
    const ledger = requireLedger();
    const head = ledger.headFact(effectStreamId(effectId));
    if (!head) return { effectId, status: "absent", materializationCount: 0 };
    switch (head.type) {
      case "effect.intended":
        return { effectId, status: "pending", materializationCount: 0 };
      case "effect.confirmed": {
        const data = Ledger.EffectConfirmed.parse(head.data);
        return {
          effectId,
          status: "confirmed",
          materializationCount: 1,
          ...(data.receipt === undefined ? {} : { receipt: data.receipt }),
        };
      }
      case "effect.failed": {
        const data = Ledger.EffectFailed.parse(head.data);
        return { effectId, status: "failed", materializationCount: 1, reason: data.reason };
      }
      default:
        throw new EffectStoreError(
          "corrupt",
          `unexpected fact type on effect stream: ${head.type}`,
          effectId,
        );
    }
  }

  /**
   * Every outcome-less intent, keyed by its effectId — the reconciler's scan.
   * An intent whose stream carries a terminal outcome fact is resolved and
   * excluded; the rest are the crash-window intents to probe under the same
   * idempotency key.
   */
  export function outstandingIntents(): readonly Ledger.EffectIntended[] {
    const ledger = requireLedger();
    const terminal = new Set<string>([
      ...ledger.factsByType("effect.confirmed").map((fact) => fact.streamId),
      ...ledger.factsByType("effect.failed").map((fact) => fact.streamId),
    ]);
    return ledger
      .factsByType("effect.intended")
      .filter((fact) => !terminal.has(fact.streamId))
      .map((fact) => Ledger.EffectIntended.parse(fact.data));
  }

  /**
   * Every intent whose stream carries a terminal outcome fact, paired with that
   * outcome — the complement of {@link outstandingIntents}, over the same
   * `factsByType` scan and fail-closed ledger. The reconciler uses it to re-run
   * the WorkItem projection for a crash between the terminal fact (tx A) and its
   * projection (tx B): both facts are already durable, so this only READS them.
   */
  export function terminalIntents(): readonly TerminalIntent[] {
    const ledger = requireLedger();
    const outcomeByStream = new Map<string, "confirmed" | "failed">();
    for (const fact of ledger.factsByType("effect.confirmed")) {
      outcomeByStream.set(fact.streamId, "confirmed");
    }
    for (const fact of ledger.factsByType("effect.failed")) {
      outcomeByStream.set(fact.streamId, "failed");
    }
    return ledger.factsByType("effect.intended").flatMap((fact) => {
      const outcome = outcomeByStream.get(fact.streamId);
      if (!outcome) return [];
      return [{ intent: Ledger.EffectIntended.parse(fact.data), outcome }];
    });
  }

  function finalize(
    effectId: string,
    type: "effect.confirmed" | "effect.failed",
    data: Record<string, unknown>,
  ): StatusView {
    const ledger = requireLedger();
    const streamId = effectStreamId(effectId);
    // The intent is seq 1, so the first terminal outcome appends at
    // expectedHead 1. A conflict means the head is not the intent: either no
    // intent exists (0) or a terminal outcome was already recorded (2).
    const appended = runEffectTransaction(effectId, () =>
      ledger.append({ streamId, type, data }, 1),
    );
    if (appended.kind === "cas_conflict") {
      const head = ledger.headFact(streamId);
      if (head?.type === type) return status(effectId); // idempotent same-outcome replay
      if (head?.type === "effect.confirmed" || head?.type === "effect.failed") {
        throw new EffectStoreError(
          "already_terminal",
          `effect ${effectId} already ${head.type}; cannot record ${type}`,
          effectId,
        );
      }
      throw new EffectStoreError(
        "not_intended",
        `effect ${effectId} has no recordable intent (head=${head?.type ?? "absent"})`,
        effectId,
      );
    }
    return status(effectId);
  }
}
