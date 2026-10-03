/**
 * `compaction` (capability) — context compaction with
 * `reason: overflow|threshold|manual|model_requested`. Single writer: the
 * compaction capability (`packages/agent/src/plugins/compaction/`).
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const CompactionReason = z.enum(["overflow", "threshold", "manual", "model_requested"]);
export type CompactionReason = z.infer<typeof CompactionReason>;

export const compaction = declare(
  "compaction",
  RowBody.superRefine(refineField("intent", "reason", CompactionReason)),
);
