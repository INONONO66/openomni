import { Machine, NamedError } from "@openomni/protocol";

const MachineCellErrorData = Machine.CellRequest.pick({ cellId: true }).extend({
  code: Machine.CellRequest.shape.cellId.refine(
    (code): code is "duplicate_cell_id" | "unknown_cell_id" =>
      code === "duplicate_cell_id" || code === "unknown_cell_id",
  ),
  message: Machine.CellRequest.shape.code,
});

export const MachineCellError = NamedError.create("MachineCellError", MachineCellErrorData);

export type MachineCellFailure = InstanceType<typeof MachineCellError>;
