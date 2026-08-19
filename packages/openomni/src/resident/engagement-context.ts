import { EngagementStore } from "@openomni/ledger";
import type { Engagement } from "@openomni/protocol";

/**
 * The engagement slice of the resident's run context (#709, gateway-design
 * §5): active engagements for the session — title, state, terms, open waits —
 * prepended as a machine-side context block, plus the resumed engagement
 * marker when the triggering delivery carried `waitContext.engagementId`
 * (the crash-safe resume point: state + terms + open waits rebuild the
 * working context; the LLM re-reasons the content).
 *
 * Hydrating also folds lazy deadline expiry (EngagementStore.listActive), so
 * an overdue delegation leaves the active set the moment the session wakes.
 *
 * Recency window note (§5): the block ACCOMPANIES the transcript, which today
 * is hydrated in full (SessionBridge.buildDirectMessages has no window).
 * Narrowing the transcript to engagement slices + a bounded recency window is
 * a recorded follow-up, not this change — segmentation stays quality-soft.
 */
export namespace EngagementContext {
  function renderTerms(terms: Engagement.Terms): string {
    const parts: string[] = [];
    if (terms.spendCeiling !== undefined) parts.push(`spendCeiling=${terms.spendCeiling}`);
    if (terms.autoApprove !== undefined) parts.push(`autoApprove="${terms.autoApprove}"`);
    if (terms.deadline !== undefined)
      parts.push(`deadline=${new Date(terms.deadline).toISOString()}`);
    if (terms.speakTriggers !== undefined && terms.speakTriggers.length > 0) {
      parts.push(`speakTriggers=[${terms.speakTriggers.join(", ")}]`);
    }
    return parts.length > 0 ? parts.join(", ") : "none recorded";
  }

  function renderRecord(record: Engagement.Record, resumed: boolean): string {
    const waits =
      record.openWaitIds.length > 0
        ? `open waits: ${record.openWaitIds.join(", ")}`
        : "no open waits";
    const responders =
      record.validResponders === undefined || record.validResponders.length === 0
        ? ""
        : `; valid responders: ${record.validResponders.join(", ")}`;
    const marker = resumed ? " ← THIS DELIVERY RESUMES THIS ENGAGEMENT" : "";
    return `- [${record.id}] "${record.title}" — state: ${record.state}; terms: ${renderTerms(
      record.terms,
    )}; ${waits}${responders}${marker}`;
  }

  /**
   * Builds the context block, or undefined when the session has no active
   * engagements and the delivery resumes none — silence costs nothing.
   */
  export function buildBlock(input: {
    readonly sessionId: string;
    readonly traceId: string;
    /** waitContext.engagementId of the triggering delivery, when present. */
    readonly resumedEngagementId?: string;
    readonly now?: number;
  }): string | undefined {
    const now = input.now ?? Date.now();
    const active = EngagementStore.listActive(input.sessionId, input.traceId, now);
    const records = [...active];
    if (
      input.resumedEngagementId !== undefined &&
      !records.some((record) => record.id === input.resumedEngagementId)
    ) {
      // Rehydration honesty: surface the resumed engagement even when it is
      // no longer active (expired/terminal) — the state IS the resume point.
      const resumed = EngagementStore.get(input.resumedEngagementId);
      if (resumed !== undefined) records.push(resumed);
    }
    if (records.length === 0) return undefined;
    const lines = records.map((record) =>
      renderRecord(record, record.id === input.resumedEngagementId),
    );
    return [
      "[engagement context — machine-recorded delegation state]",
      "These are this session's durable engagements: what was delegated, its terms,",
      "the current authority state, and which waits may resume it. The machine owns",
      "the state edges and the audit trail; judging terms against reality is YOUR",
      "job — report a term crossing via engagement.transition (termCrossed=true).",
      ...lines,
    ].join("\n");
  }
}
