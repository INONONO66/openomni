/**
 * `prompt` — a turn input of human/contact/alarm/nudge origin.
 * Single writer: the entity deliver path (`packages/agent/src/core/commit.ts`);
 * capability handlers reach it only through that constructor.
 * `delivery: steer|followUp` (default `followUp`) picks consumption width.
 */
import { Delivery, RowBody, declare, refineField } from "../declaration.js";

export const prompt = declare(
  "prompt",
  RowBody.superRefine(refineField("intent", "delivery", Delivery)),
);
