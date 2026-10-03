/**
 * `alarm` — one timer kind: `arm{purpose, at, supersedes}` and
 * `fired{occurrenceId, outcome: delivered|stale|exhausted}`; the former
 * `alarm.arm`/`alarm.fired`/`alarm.paused` kinds collapse here (a paused
 * monitor is a fired outcome `exhausted`). Single writer: the core timer
 * constructor (`packages/agent/src/core/alarm.ts`).
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

export const Op = z.enum(["arm", "fired"]);
export type Op = z.infer<typeof Op>;

export const FiredOutcome = z.enum(["delivered", "stale", "exhausted"]);
export type FiredOutcome = z.infer<typeof FiredOutcome>;

export const alarm = declare(
  "alarm",
  RowBody.superRefine(refineField("intent", "op", Op)).superRefine(
    refineField("intent", "outcome", FiredOutcome),
  ),
);
