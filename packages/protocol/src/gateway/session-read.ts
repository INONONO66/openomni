import { z } from "zod";
import { LedgerAction, LedgerSession } from "../ledger/l0.js";
import { Gateway } from "./schema.js";

const Id = z.string().min(1);
const Revision = z.number().int().nonnegative();

/** Plain data shared by the app-owned reader and its WebSocket consumers. */
export namespace SessionRead {
  export const Cursor = z.object({ revision: Revision, epoch: Revision }).strict();
  export type Cursor = z.infer<typeof Cursor>;

  export const Request = z.object({
    type: z.literal("session_read"),
    sessionId: Id,
    limit: z.number().int().positive().max(256),
    cursor: Cursor.optional(),
  }).strict();
  export type Request = z.infer<typeof Request>;

  export const Page = z.object({
    type: z.enum(["session_snapshot", "session_page"]),
    sessionId: Id,
    state: LedgerSession.State,
    phase: z.enum([
      "queued", "running", "waiting_approval", "waiting_input", "interrupted",
      "completed", "failed", "idle", "archived",
    ]),
    phaseSince: z.number().nonnegative(),
    epoch: Revision,
    afterRevision: Revision,
    headRevision: Revision,
    nextRevision: Revision.nullable(),
    actions: z.array(z.object({
      revision: Revision,
      actionId: Id,
      kind: LedgerAction.Kind,
      at: z.number().nonnegative(),
    }).strict()).max(256),
    usage: z.array(z.object({
      attemptId: Id,
      provenance: z.enum(["reported", "estimated", "unknown"]),
      inputTokens: z.number().nonnegative().nullable(),
      outputTokens: z.number().nonnegative().nullable(),
    }).strict()).max(256),
    toolWallMs: z.number().nonnegative(),
  }).strict();
  export type Page = z.infer<typeof Page>;

  export const Gap = z.object({
    type: z.literal("session_gap"),
    sessionId: Id,
    epoch: Revision,
    headRevision: Revision,
    oldestRevision: Revision,
  }).strict();
  export const Response = z.union([Page, Gap]);
  export type Response = z.infer<typeof Response>;

  /** The admitted target is the durable identity, never a renderer-created id. */
  export const Receipt = z.object({
    type: z.literal("receipt"),
    status: z.literal("accepted"),
    result: Gateway.IngestResult.optional(),
  }).strict();
}
