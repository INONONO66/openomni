/**
 * `session.configure` — generation change: manifest hash, role, parent,
 * bundles and `settings{steering, followUp}` holding the `all|one`
 * consumption width. Single writer: the entity configure constructor
 * (`packages/agent/src/core/store/fence.ts`), also used at genesis by the app
 * cluster runtime and by `Session.fork` (#1257), whose child genesis pins the
 * fork boundary in `forkedFrom`.
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

/**
 * Fork ancestry pinned at child genesis (#1257): the parent session, the
 * boundary anchor (the parent action hash forked at), the anchor's parent
 * ordinal, the parent chain head at fork time (so later parent appends cannot
 * alter verification) and how many parent rows were copied onto the child
 * chain after genesis.
 */
export const ForkedFrom = z
  .object({
    session: z.string().min(1),
    anchor: z.string().min(1),
    parentSeq: z.number().int().positive(),
    parentHead: z.string().min(1),
    copied: z.number().int().nonnegative(),
  })
  .strict();
export type ForkedFrom = z.infer<typeof ForkedFrom>;

export const sessionConfigure = declare(
  "session.configure",
  RowBody.superRefine(refineField("intent", "settings", Settings)).superRefine(
    refineField("intent", "forkedFrom", ForkedFrom),
  ),
);
