import { seam, type SeamTag } from "./capability";
import type { ResolvedAgentBudget } from "./types";

/**
 * The approval-policy seam (#1309): the four product decisions the core used
 * to hard-code — who answers an approval, how many approvals a session may
 * hold open per window, how long an approval stays open when nothing names an
 * expiry, and the default run budget — read through one injected data shape.
 * Plain data only, no callbacks; the bundle that provides the seam owns the
 * literals (`apps/openomni/src/bundles/approval-policy`). The core has no
 * fallback: composition threads this value in, and a manifest without a
 * provider refuses `seam_missing` at compose.
 */
export interface ApprovalPolicy {
  /** `expectedResponders` written into every approval request the core opens. */
  readonly responders: readonly string[];
  /** Recent-open quota: at most `limit` open approvals per `windowMs`. */
  readonly recentOpen: ApprovalRecentOpen;
  /** Expiry when neither the binding nor the executor options name one. */
  readonly defaultExpiryMs: number;
  /** The run budget a run with no explicit budget resolves against. */
  readonly defaultBudget: ResolvedAgentBudget;
}

/** The recent-open approval quota the pure request authority enforces. */
export interface ApprovalRecentOpen {
  readonly limit: number;
  readonly windowMs: number;
}

/** The seam tag an approval-policy bundle `provides` and compose resolves. */
export const ApprovalPolicySeam: SeamTag = seam("@openomni/approval/ApprovalPolicy");
