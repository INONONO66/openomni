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
export type EffectEscalation = (intent: EffectIntent, detail: string) => void | Promise<void>;

export type ReconcileSummary = Readonly<{
  scanned: number;
  resolved: number;
  stillUnknown: number;
  escalated: number;
}>;

export class EffectReconciler {
  constructor(
    private readonly manifest: EffectManifest,
    private readonly escalate?: EffectEscalation,
  ) {}

  async reconcile(): Promise<ReconcileSummary> {
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
            );
          }
          break;
      }
    }

    return { scanned: outstanding.length, resolved, stillUnknown, escalated };
  }

  private async escalateOrThrow(intent: EffectIntent, detail: string): Promise<number> {
    if (!this.escalate) {
      throw new Error(
        `effect ${intent.effectId} reconciliation exhausted with no escalation seam — refusing to terminalize (${detail})`,
      );
    }
    await this.escalate(intent, detail);
    return 1;
  }

  private linkTerminal(intent: EffectIntent, outcome: "confirmed" | "failed"): void {
    if (intent.workItemHash === undefined) return;
    WorkItemStore.recordEffect(intent.workItemHash, { intentRef: intent.effectId, outcome });
  }
}
