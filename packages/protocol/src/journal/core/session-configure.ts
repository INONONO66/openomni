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

/** One intended deactivation of the off cascade (#1255): `because` is the root `off` name. */
export const DisabledEntry = z.object({ name: z.string().min(1), because: z.string().min(1) }).strict();
export type DisabledEntry = z.infer<typeof DisabledEntry>;

/** The composed generation's full off cascade, journaled with the configure. */
export const Disabled = z.array(DisabledEntry);
export type Disabled = z.infer<typeof Disabled>;

export const sessionConfigure = declare(
  "session.configure",
  RowBody.superRefine(refineField("intent", "settings", Settings)).superRefine(
    refineField("intent", "disabled", Disabled),
  ),
);
