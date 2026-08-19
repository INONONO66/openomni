import { z } from "zod";
import { NamedError } from "../error/index.js";

/**
 * Engagement — the durable delegation object (gateway-design §5, #709).
 *
 * One record per delegation ("sell the bike, floor 50000"). The machine owns
 * **authority and resumption, never dialogue content** (design non-goal §10):
 * it records the Owner's terms verbatim, tracks which waits may resume it,
 * and forces the approval stop when a term crossing is REPORTED — it never
 * evaluates prices, criteria, or negotiation moves itself. Judgment stays in
 * the LLM; the machine enforces edges.
 */

export const State = z.enum([
  "planning",
  "awaiting_external",
  "deliberating",
  "awaiting_user_approval",
  "acting",
  "done",
  "aborted",
  "expired",
]);
export type State = z.infer<typeof State>;

/**
 * Delegation terms, recorded verbatim at open. `autoApprove` is Owner text —
 * whether a situation satisfies it is the LLM's judgment; the machine only
 * stores the words and records the reported verdict. `deadline` is the one
 * term the machine acts on mechanically (expiry). Extensible strict object:
 * new terms are additive-optional fields, never free-form maps.
 */
export const Terms = z
  .object({
    spendCeiling: z.number().positive().optional(),
    autoApprove: z.string().min(1).optional(),
    deadline: z.number().optional(),
    speakTriggers: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Terms = z.infer<typeof Terms>;

export const Record = z
  .object({
    id: z.string().min(1),
    /** The session that owns this delegation — waits opened under it stay session-owned and route here. */
    ownerSessionId: z.string().min(1),
    /** The delegation, one line ("sell bike, floor 50000"). */
    title: z.string().min(1),
    state: State,
    terms: Terms,
    /** Waits that may resume this engagement in its current state. */
    openWaitIds: z.array(z.string().min(1)),
    /** Machine-enforced expiry instant, seeded from terms.deadline at open. */
    expiresAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type Record = z.infer<typeof Record>;

/**
 * Input shape for opening an engagement. Every engagement starts in
 * `planning` with no open waits; `expiresAt` is seeded from `terms.deadline`
 * by the factory below — callers never set machine fields.
 */
export const Create = Record.omit({
  state: true,
  openWaitIds: true,
  expiresAt: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  createdAt: z.number().optional(),
});
export type Create = z.infer<typeof Create>;

/**
 * Deterministic open: `at` is injected — the factory never reads the wall
 * clock. Revision starts at 1 — the engagement.opened fact is seq 1 on the
 * owner stream, so head === revision from birth (the Wait precedent).
 */
export function open(input: Create, at: number): Record {
  const createdAt = input.createdAt ?? at;
  return Record.parse({
    id: input.id,
    ownerSessionId: input.ownerSessionId,
    title: input.title,
    state: "planning",
    terms: input.terms,
    openWaitIds: [],
    ...(input.terms.deadline === undefined ? {} : { expiresAt: input.terms.deadline }),
    createdAt,
    updatedAt: createdAt,
    revision: 1,
  });
}

export const StoreErrorCode = z.enum([
  "adapter_absent",
  "duplicate",
  "not_found",
  "revision_conflict",
  /** Storage was busy (SQLITE_BUSY at the transaction entry) — nothing was written; retrying is the caller's decision. */
  "unavailable",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCode>;

/**
 * Typed failure taxonomy for durable engagement persistence. A missing
 * sub-adapter is `adapter_absent` — durable writes fail closed, never
 * warn-and-return (the Wait store precedent). Callers branch on `data.code`,
 * never message text.
 */
export const StoreError = NamedError.create(
  "EngagementStoreError",
  z.object({
    message: z.string(),
    code: StoreErrorCode,
    engagementId: z.string().min(1).optional(),
  }),
);
