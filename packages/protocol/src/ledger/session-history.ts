import { z } from "zod";
import { EpochMs } from "../time.js";
import { LedgerAction } from "./l0.js";

const Id = z.string().min(1);
const Revision = z.number().int().nonnegative();

/**
 * Read projections over one session's append-only action history. Every value
 * here is derived from committed actions at read time; nothing in this
 * namespace is stored, and bus notifications are only hints to re-read.
 */
export namespace SessionHistory {
  /** One bounded, revision-ordered slice of committed actions. */
  export const Page = z
    .object({
      sessionId: Id,
      afterRevision: Revision,
      headRevision: Revision,
      actions: z.array(LedgerAction.Node),
      nextRevision: Revision.nullable(),
    })
    .strict()
    .superRefine((page, context) => {
      let previous = page.afterRevision;
      for (const action of page.actions) {
        if (action.ordinal <= previous || action.ordinal > page.headRevision) {
          context.addIssue({
            code: "custom",
            path: ["actions"],
            message: "page actions must ascend strictly within (afterRevision, headRevision]",
          });
          return;
        }
        previous = action.ordinal;
      }
      const last = page.actions.at(-1)?.ordinal ?? page.afterRevision;
      const expected = last < page.headRevision ? last : null;
      if (page.nextRevision !== expected) {
        context.addIssue({
          code: "custom",
          path: ["nextRevision"],
          message: "nextRevision must continue an incomplete page and be null at the head",
        });
      }
    });
  export type Page = z.infer<typeof Page>;

  export const PageRequest = z
    .object({
      afterRevision: Revision.default(0),
      limit: z.number().int().positive().max(1_000).default(100),
    })
    .strict();
  export type PageRequest = z.input<typeof PageRequest>;

  /** Settlement vocabulary; `outcome_unknown` is never folded into `failed` or `executed`. */
  export const Outcome = z.enum([
    "pending",
    "executed",
    "failed",
    "blocked_pre",
    "blocked_post",
    "cancelled",
    "outcome_unknown",
  ]);
  export type Outcome = z.infer<typeof Outcome>;

  /**
   * The committed record that caused a transition. `action` is the parent
   * action, `inbox` the admitted rows a turn or delivery consumed, `alarm` the
   * coordination row whose firing woke the session, and `root` a record with
   * no parent in the tree: the session declaration or an armed alarm row.
   */
  export const Cause = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("action"), actionId: Id }).strict(),
    z.object({ kind: z.literal("inbox"), inboxIds: z.array(Id).min(1) }).strict(),
    z.object({ kind: z.literal("alarm"), alarmId: Id, epoch: z.number().int() }).strict(),
    z.object({ kind: z.literal("root") }).strict(),
  ]);
  export type Cause = z.infer<typeof Cause>;

  export const Phase = z.enum([
    "configure",
    "delivery",
    "intent",
    "checkpoint",
    "terminal",
    "decision",
    "result",
    "state",
    "record",
  ]);
  export type Phase = z.infer<typeof Phase>;

  /**
   * One committed action as an inspectable transition. It carries identities,
   * hashes and terminals only; raw intent/effect payloads never enter the
   * projection, so credentials captured in tool input cannot leak through it.
   */
  export const Transition = z
    .object({
      revision: z.number().int().positive(),
      actionId: Id,
      parentId: Id.nullable(),
      sessionId: Id,
      kind: LedgerAction.Kind,
      phase: Phase,
      op: z.string().nullable(),
      at: EpochMs,
      turnId: Id.nullable(),
      callId: Id.nullable(),
      requestId: Id.nullable(),
      peerSessionId: Id.nullable(),
      cause: Cause,
      outcome: Outcome.nullable(),
      reason: z.string().nullable(),
      digest: Id,
    })
    .strict();
  export type Transition = z.infer<typeof Transition>;

  export const PolicyDecision = z
    .object({
      revision: z.number().int().positive(),
      actionId: Id,
      subjectActionId: Id.nullable(),
      turnId: Id.nullable(),
      hook: z.string(),
      op: z.string(),
      generation: z.number().int().nonnegative(),
      matchedRuleIds: z.array(z.string()),
      verdict: z.string(),
      reason: z.string().nullable(),
      inputHash: z.string(),
    })
    .strict();
  export type PolicyDecision = z.infer<typeof PolicyDecision>;

  export const PolicyFilter = z
    .object({
      generation: z.number().int().nonnegative().optional(),
      ruleId: z.string().optional(),
      verdict: z.string().optional(),
    })
    .strict();
  export type PolicyFilter = z.infer<typeof PolicyFilter>;

  /** What an executed compaction left behind; the discarded originals stay in history. */
  export const Compaction = z
    .object({
      compactionId: Id,
      resultId: Id,
      revision: z.number().int().positive(),
      turnId: Id.nullable(),
      summaryDigest: Id,
      firstKeptEntryId: Id,
      discarded: z
        .object({
          firstEntryId: Id,
          lastEntryId: Id,
          count: z.number().int().nonnegative(),
          sha256: Id,
        })
        .strict(),
      restoredBy: z.array(Id),
    })
    .strict();
  export type Compaction = z.infer<typeof Compaction>;

  export const Request = z
    .object({
      requestId: Id,
      revision: z.number().int().positive(),
      turnId: Id.nullable(),
      callId: Id,
      mode: z.enum(["approval", "reply"]),
      inputHash: Id,
      state: z.enum(["open", "resolved", "refused", "expired", "cancelled"]),
      outcome: Outcome,
      deadline: EpochMs,
      expectedResponders: z.array(Id),
      replyCount: z.number().int().nonnegative(),
    })
    .strict();
  export type Request = z.infer<typeof Request>;

  export const InspectRequest = z
    .object({
      /** Descendant sessions to include; traversal never leaves the commissioned tree. */
      depth: z.number().int().nonnegative().max(8).default(1),
    })
    .strict();
  export type InspectRequest = z.input<typeof InspectRequest>;

  export interface Inspection {
    readonly sessionId: string;
    readonly parentId: string | null;
    readonly headRevision: number;
    readonly transitions: readonly Transition[];
    readonly policy: readonly PolicyDecision[];
    readonly requests: readonly Request[];
    readonly compactions: readonly Compaction[];
    readonly children: readonly Inspection[];
  }

  const InspectionBase = z.object({
    sessionId: Id,
    parentId: Id.nullable(),
    headRevision: Revision,
    transitions: z.array(Transition),
    policy: z.array(PolicyDecision),
    requests: z.array(Request),
    compactions: z.array(Compaction),
  });

  export const Inspection: z.ZodType<Inspection> = InspectionBase.extend({
    children: z.lazy(() => z.array(Inspection)),
  }).strict();
}
