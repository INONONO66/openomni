import { Machine, NamedError } from "@openomni/protocol";
import { z } from "zod";

const MachineCellErrorData = Machine.CellRequest.pick({ cellId: true }).extend({
  code: Machine.CellRequest.shape.cellId.refine(
    (code): code is "duplicate_cell_id" | "unknown_cell_id" =>
      code === "duplicate_cell_id" || code === "unknown_cell_id",
  ),
  message: Machine.CellRequest.shape.code,
});

export const MachineCellError = NamedError.create("MachineCellError", MachineCellErrorData);

export type MachineCellFailure = InstanceType<typeof MachineCellError>;

const MachineDaemonProtocolErrorData = z.object({
  reason: z.literal("capability_not_offered"),
  capability: z.string(),
  message: z.string(),
});

export const MachineDaemonProtocolError = NamedError.create(
  "MachineDaemonProtocolError",
  MachineDaemonProtocolErrorData,
);

export type MachineDaemonProtocolFailure = InstanceType<typeof MachineDaemonProtocolError>;
