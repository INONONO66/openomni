/**
 * `session.configure` — generation change: manifest hash, role, parent,
 * bundles and `settings{steering, followUp}` holding the `all|one`
 * consumption width. Single writer: the entity configure constructor
 * (`packages/agent/src/core/store/fence.ts`), also used at genesis by the app
 * cluster runtime.
 */
import { z } from "zod";
import { RowBody, declare, refineField } from "../declaration.js";

/** How many queued inputs one boundary consumes for each delivery mode. */
export const ConsumptionWidth = z.enum(["all", "one"]);
export type ConsumptionWidth = z.infer<typeof ConsumptionWidth>;

export const Settings = z
  .object({ steering: ConsumptionWidth, followUp: ConsumptionWidth })
  .strict();
export type Settings = z.infer<typeof Settings>;

export const sessionConfigure = declare(
  "session.configure",
  RowBody.superRefine(refineField("intent", "settings", Settings)),
);
