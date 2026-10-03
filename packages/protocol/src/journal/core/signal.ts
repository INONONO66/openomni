/**
 * `signal` — interrupt/resume/cancel control, consumed at the next boundary,
 * never a turn input. Single writer: the entity deliver path
 * (`packages/agent/src/core/commit.ts`).
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const Control = z.enum(["interrupt", "resume", "cancel"]);
export type Control = z.infer<typeof Control>;

export const signal = declare(
  "signal",
  RowBody.superRefine(refineField("intent", "control", Control)),
);
