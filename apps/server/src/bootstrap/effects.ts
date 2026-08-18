import { Operational, WorkItem } from "@openomni/protocol";
import {
  EffectManifest,
  EffectReconciler,
  EffectService,
  type EffectDriver,
  type EffectEscalation,
} from "@openomni/openomni";
import { WorkItemStore } from "@openomni/session";
import { Bus } from "@openomni/telemetry";

/**
 * #492 boot composition — the first production consumer of the effect
 * substrate #526 shipped dormant. The manifested kinds are the issue's Manual
 * QA drivers, driven through the authenticated `/admin/effects/*` surface:
 * they exercise the full record-before-act → crash-window → reconcile
 * plumbing on a live server without reaching outside the process. Production
 * effect kinds (dispatch/schedule/connector/worker) enroll here as their
 * kernel call sites adopt `EffectService` (tracked under #459).
 */

/**
 * Simulates the crash window: the run reaches the world but the process dies
 * before the outcome lands. `execute` reports the transient `unknown` (no
 * terminal fact — the intent stays outcome-less), and the boot reconciler's
 * probe finds the effect landed and records `confirmed`.
 */
const crashAfterIntent: EffectDriver = {
  kind: "crash-after-intent",
  // Models the crash window itself — re-execution would falsify the scenario.
  replay: "never",
  execute: () => ({ kind: "unknown", reason: "simulated crash between intent and outcome" }),
  reconcile: () => ({
    kind: "confirmed",
    receipt: "probe: effect landed (simulated crash window)",
  }),
};

/** Definite failure — observably distinct from `unknown`: a terminal fact IS recorded. */
const definiteFailure: EffectDriver = {
  kind: "definite-failure",
  replay: "never",
  execute: () => ({ kind: "failed", reason: "definite failure (scenario)" }),
  reconcile: () => ({ kind: "failed", reason: "definite failure (scenario)" }),
};

/** Unprovable outcome — stays outcome-less and reconcilable across sweeps, never terminalized. */
const unknownResult: EffectDriver = {
  kind: "unknown-result",
  replay: "never",
  execute: () => ({ kind: "unknown", reason: "outcome unprovable (scenario)" }),
  reconcile: () => ({ kind: "unknown", reason: "outcome unprovable (scenario)" }),
};

/** Owner-driven manual effect: confirms immediately; input is boundary-checked below. */
const manualDriver: EffectDriver = {
  kind: "manual",
  // In-process idempotent confirm — the one live "safe" row for Manual QA.
  replay: "safe",
  execute: () => ({ kind: "confirmed", receipt: "manual effect confirmed" }),
  reconcile: () => ({ kind: "confirmed", receipt: "manual effect confirmed (reconciled)" }),
};

/**
 * Exhaustion scenario — the driver gives up on the first probe, so the Stakes
 * escalation seam is drivable end-to-end through `/admin/effects/*` (intent →
 * reconcile → `waiting_input` blocker), not only from test fixtures. Like
 * `unknown-result`, the intent deliberately stays outcome-less forever.
 */
const exhaustingProbe: EffectDriver = {
  kind: "exhausting-probe",
  replay: "never",
  execute: () => ({ kind: "unknown", reason: "outcome unprovable (scenario)" }),
  reconcile: () => ({
    kind: "unknown",
    reason: "probe exhausted (scenario)",
    exhausted: true,
  }),
};

/**
 * Boundary sanitizer for the manual kind: only a plain JSON object (or no
 * input at all) crosses; strings and arrays — including path-traversal
 * payloads — are refused BEFORE any ledger write (`unsanitized_input`,
 * materializationCount 0).
 */
function sanitizeManualInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input;
  throw new Error("manual effect input must be a plain JSON object");
}

/**
 * The injected Stakes escalation seam (kernel-contract §retry policy):
 * exhausted reconciliation gains a durable `waiting_input` blocker on the
 * linked WorkItem — admission stays blocked and the Owner is asked — plus a
 * loud Operational error. An intent with no WorkItem link still surfaces
 * loudly and stays outstanding for the next sweep; it is never terminalized.
 */
const TERMINAL_WORK_ITEM_STATUSES = new Set(["completed", "failed", "cancelled"]);

function createEffectEscalation(): EffectEscalation {
  return async (intent, detail, traceId) => {
    const escalation = await recordEscalationBlocker(intent.workItemHash, intent, detail, traceId);
    Bus.publish(Operational.Error, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: `effect reconciliation exhausted — escalated to Owner: ${intent.effectId}`,
      context: {
        effectId: intent.effectId,
        kind: intent.kind,
        ...(intent.workItemHash === undefined ? {} : { workItemHash: intent.workItemHash }),
        blocker: escalation,
        detail,
      },
    });
  };
}

/**
 * The durable half of the escalation. Deterministic blocker id keyed by the
 * effectId so an exhausted-but-still-outstanding intent is re-escalated by
 * every sweep WITHOUT stacking a new blocker per boot; a terminal or missing
 * WorkItem gets no blocker (admission is no longer in play) but the loud
 * event above still fires. A blocker write failure is reported distinctly and
 * never aborts the sweep — the intent stays outstanding either way.
 */
async function recordEscalationBlocker(
  workItemHash: string | undefined,
  intent: Parameters<EffectEscalation>[0],
  detail: string,
  traceId: string,
): Promise<string> {
  if (workItemHash === undefined) return "skipped:no_work_item_link";
  const blockerId = `effect-escalation:${intent.effectId}`;
  try {
    const item = await WorkItemStore.get(workItemHash);
    if (!item) return "failed:work_item_missing";
    const status = WorkItem.deriveStatus(item);
    if (TERMINAL_WORK_ITEM_STATUSES.has(status)) return `skipped:work_item_${status}`;
    const existing = item.blockers.find(
      (blocker) => blocker.id === blockerId && blocker.resolvedAt === undefined,
    );
    if (existing) return "already_recorded";
    const updated = await WorkItemStore.addBlocker(
      workItemHash,
      {
        id: blockerId,
        kind: "waiting_input",
        description: `effect ${intent.effectId} (${intent.kind}) reconciliation exhausted — Owner decision required: ${detail}`,
      },
      traceId,
    );
    return updated ? "recorded" : "failed:blocker_not_recorded";
  } catch (error) {
    return `failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

export type EffectRuntime = Readonly<{
  manifest: EffectManifest;
  service: EffectService;
  reconciler: EffectReconciler;
}>;

export function assembleEffectRuntime(): EffectRuntime {
  const manifest = new EffectManifest();
  manifest.register(crashAfterIntent);
  manifest.register(definiteFailure);
  manifest.register(unknownResult);
  manifest.register(exhaustingProbe);
  manifest.register(manualDriver, sanitizeManualInput);
  const reconciler = new EffectReconciler(manifest, createEffectEscalation());
  return { manifest, service: new EffectService(manifest), reconciler };
}
