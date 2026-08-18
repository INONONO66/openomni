import { EffectStore, WorkItemStore } from "@openomni/ledger";
import type { EffectExecution, EffectIntent } from "./driver.js";
import type { EffectManifest } from "./manifest.js";

/**
 * #492 effect service — the single kernel entry that wires the manifest
 * (boundary), the store (durability), and the driver (side effect) into the
 * normative sequence. It owns "record-before-act": the intent is durable
 * BEFORE the driver runs, and on a crash the outcome-less intent is the
 * reconciler's to resolve.
 *
 *   manifest.resolve/sanitize  →  refuse unsafe/unknown BEFORE any write
 *   EffectStore.intend         →  record intent (seq 1) — record-before-act
 *   WorkItemStore.recordEffect →  block completion admission (pending)
 *   driver.execute             →  reach the world idempotently
 *   EffectStore.confirm/fail   →  record the ONE terminal outcome (seq 2)
 *
 * A replay (the effectId was already intended) NEVER re-executes: a terminal
 * intent returns the recorded outcome; a still-pending intent is handed to the
 * driver's reconcile probe (the first attempt may have reached the world).
 */
export type EffectRequest = Readonly<{
  /** The intent event id — the idempotency key reconciliation resolves under. */
  effectId: string;
  kind: string;
  target?: string;
  /** Links the effect to a WorkItem so completion admission blocks until terminal. */
  workItemHash?: string;
  attemptId?: string;
  /** Transient, driver-specific request payload — sanitized, never persisted. */
  input?: unknown;
}>;

export type EffectRunResult = Readonly<{
  effectId: string;
  /** The runtime disposition of THIS run — includes the transient `unknown`. */
  runtime: "confirmed" | "failed" | "unknown";
  /** The durable ledger status (pending while the outcome is unknown). */
  ledger: EffectStore.StatusView;
}>;

export class EffectService {
  constructor(private readonly manifest: EffectManifest) {}

  async run(request: EffectRequest): Promise<EffectRunResult> {
    // Boundary first: refuse unmanifested/unsanitized requests BEFORE any
    // ledger write (an EffectRefusal escapes with materializationCount 0).
    const driver = this.manifest.resolve(request.kind);
    const input = this.manifest.sanitize(request.kind, request.input);

    const intended = EffectStore.intend({
      effectId: request.effectId,
      kind: request.kind,
      // The driver's replay declaration rides the intent fact so replay and
      // recovery read the judgment from the ledger, never re-derive it.
      replay: driver.replay,
      ...(request.target === undefined ? {} : { target: request.target }),
      ...(request.workItemHash === undefined ? {} : { workItemHash: request.workItemHash }),
      ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
    });

    if (!intended.fresh) {
      // Idempotency key hit. A terminal intent replays its recorded outcome;
      // a still-pending intent is reconciled (never blindly re-executed).
      if (intended.status.status !== "pending") {
        // Seam (b) for #538 — re-project the recorded terminal outcome onto the
        // WorkItem BEFORE returning. EffectStore.confirm/fail commits the
        // terminal fact (tx A) and this projection (tx B) is a LATER
        // transaction; a crash between them leaves admission blocked forever on
        // an outcome-less record. recordWorkItemEffect is idempotent
        // (same-outcome latest → no-op), so a redundant replay costs nothing.
        const outcome = runtimeOf(intended.status.status);
        this.linkEffect(intended.intent, outcome);
        return {
          effectId: request.effectId,
          runtime: outcome,
          ledger: intended.status,
        };
      }
      return this.finalize(intended.intent, await driver.reconcile(intended.intent));
    }

    // Fresh intent recorded — link the WorkItem so admission blocks, then act.
    this.linkEffect(intended.intent, undefined);
    return this.finalize(intended.intent, await driver.execute(intended.intent, input));
  }

  private finalize(intent: EffectIntent, execution: EffectExecution): EffectRunResult {
    switch (execution.kind) {
      case "confirmed": {
        const ledger = EffectStore.confirm(intent.effectId, execution.receipt);
        this.linkEffect(intent, "confirmed");
        return { effectId: intent.effectId, runtime: "confirmed", ledger };
      }
      case "failed": {
        const ledger = EffectStore.fail(intent.effectId, execution.reason);
        this.linkEffect(intent, "failed");
        return { effectId: intent.effectId, runtime: "failed", ledger };
      }
      case "unknown": {
        // No terminal fact — the intent stays outcome-less and reconcilable.
        // Record an explicit `unknown` on the WorkItem so admission keeps
        // blocking rather than silently admitting an unresolved effect.
        this.linkEffect(intent, "unknown");
        return {
          effectId: intent.effectId,
          runtime: "unknown",
          ledger: EffectStore.status(intent.effectId),
        };
      }
    }
  }

  private linkEffect(
    intent: EffectIntent,
    outcome: "unknown" | "confirmed" | "failed" | undefined,
  ): void {
    if (intent.workItemHash === undefined) return;
    WorkItemStore.recordEffect(intent.workItemHash, {
      intentRef: intent.effectId,
      ...(outcome === undefined ? {} : { outcome }),
    });
  }
}

function runtimeOf(status: EffectStore.Status): "confirmed" | "failed" | "unknown" {
  return status === "confirmed" || status === "failed" ? status : "unknown";
}
