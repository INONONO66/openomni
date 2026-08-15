import type { WorkItem } from "@openomni/protocol";
import { EffectStore, WorkItemStore } from "@openomni/session";
import type { EffectIntent } from "./driver.js";
import type { EffectManifest } from "./manifest.js";

/**
 * #492 finish reconciliation — the boot/periodic sweep that resolves every
 * outcome-less intent under its effectId idempotency key. For each outstanding
 * intent the manifested driver PROBES the external world (never re-issues):
 *
 *   confirmed / failed  →  record the terminal outcome + unblock the WorkItem;
 *   unknown             →  leave outcome-less (still reconcilable next sweep);
 *   unknown + exhausted →  ESCALATE by Stakes — never silently terminalize.
 *
 * Fold state is authoritative for internal state; the external world is
 * eventually consistent through this probe, not a two-phase commit. Exhaustion
 * fails closed: with no escalation seam wired, an exhausted intent throws
 * rather than being force-terminalized.
 */
export type EffectEscalation = (
  intent: EffectIntent,
  detail: string,
  traceId: string,
) => void | Promise<void>;

export type ReconcileSummary = Readonly<{
  scanned: number;
  resolved: number;
  stillUnknown: number;
  escalated: number;
  /**
   * Crash-window WorkItems re-linked by {@link EffectReconciler.reprojectTerminalOutcomes}
   * — intents already terminal in the ledger whose read-model projection was
   * still outcome-less (#538). Distinct from `resolved`: nothing is terminalized
   * or re-executed, only an already-recorded outcome is projected.
   */
  reprojected: number;
}>;

export class EffectReconciler {
  constructor(
    private readonly manifest: EffectManifest,
    private readonly escalate?: EffectEscalation,
  ) {}

  /** `traceId` is the sweep caller's trace (boot recovery / admin request) — escalations record under it. */
  async reconcile(traceId: string): Promise<ReconcileSummary> {
    const outstanding = EffectStore.outstandingIntents();
    let resolved = 0;
    let stillUnknown = 0;
    let escalated = 0;

    for (const intent of outstanding) {
      const driver = this.manifest.tryResolve(intent.kind);
      if (!driver) {
        // An outstanding intent whose kind is no longer manifested is an
        // anomaly, not a resolution — escalate (or fail closed) rather than
        // abandon or terminalize it.
        stillUnknown += 1;
        escalated += await this.escalateOrThrow(
          intent,
          `no driver manifested for outstanding effect kind: ${intent.kind}`,
          traceId,
        );
        continue;
      }

      const execution = await driver.reconcile(intent);
      switch (execution.kind) {
        case "confirmed":
          EffectStore.confirm(intent.effectId, execution.receipt);
          this.linkTerminal(intent, "confirmed");
          resolved += 1;
          break;
        case "failed":
          EffectStore.fail(intent.effectId, execution.reason);
          this.linkTerminal(intent, "failed");
          resolved += 1;
          break;
        case "unknown":
          stillUnknown += 1;
          if (execution.exhausted) {
            escalated += await this.escalateOrThrow(
              intent,
              execution.reason ?? "effect reconciliation exhausted",
              traceId,
            );
          }
          break;
      }
    }

    const reprojected = this.reprojectTerminalOutcomes();
    return { scanned: outstanding.length, resolved, stillUnknown, escalated, reprojected };
  }

  /**
   * Seam (a) for #538 — heals the crash window between an effect's terminal fact
   * (EffectStore.confirm/fail, tx A) and its WorkItem projection (recordEffect,
   * the later tx B). A crash there leaves the stream terminal but
   * `completionFacts.effects` stuck on an outcome-less record, so the admission
   * fold blocks on `effect_outcome_unresolved` forever — and
   * {@link EffectStore.outstandingIntents} EXCLUDES terminal streams, so the
   * probe loop above never revisits it. This pass re-projects
   * ALREADY-RECORDED terminal outcomes only; it NEVER terminalizes or
   * re-executes. The recordEffect idempotency guard makes already-linked intents
   * no-ops, so only genuinely-stuck WorkItems gain a new EffectRecord (counted).
   */
  private reprojectTerminalOutcomes(): number {
    let reprojected = 0;
    for (const { intent, outcome } of EffectStore.terminalIntents()) {
      if (intent.workItemHash === undefined) continue;
      const item = WorkItemStore.get(intent.workItemHash);
      if (!item) continue;
      // Already projected → the fold reads the terminal record; nothing to do.
      if (latestEffectOutcome(item, intent.effectId) === outcome) continue;
      this.linkTerminal(intent, outcome);
      reprojected += 1;
    }
    return reprojected;
  }

  private async escalateOrThrow(
    intent: EffectIntent,
    detail: string,
    traceId: string,
  ): Promise<number> {
    if (!this.escalate) {
      throw new Error(
        `effect ${intent.effectId} reconciliation exhausted with no escalation seam — refusing to terminalize (${detail})`,
      );
    }
    await this.escalate(intent, detail, traceId);
    return 1;
  }

  private linkTerminal(intent: EffectIntent, outcome: "confirmed" | "failed"): void {
    if (intent.workItemHash === undefined) return;
    WorkItemStore.recordEffect(intent.workItemHash, { intentRef: intent.effectId, outcome });
  }
}

/**
 * The latest EffectRecord outcome for one intent (mirrors the admission fold's
 * latest-by-createdAt selection): `undefined` when outcome-less or absent.
 */
function latestEffectOutcome(
  item: WorkItem.Info,
  intentRef: string,
): WorkItem.EffectRecord["outcome"] {
  let latest: WorkItem.EffectRecord | undefined;
  for (const record of item.completionFacts.effects) {
    if (record.intentRef !== intentRef) continue;
    if (!latest || record.createdAt >= latest.createdAt) latest = record;
  }
  return latest?.outcome;
}
