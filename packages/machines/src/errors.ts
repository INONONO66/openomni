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

export const MachineRefusalError = NamedError.create("MachineRefusalError", z.object({
  reason: z.enum(["machine_not_attached", "fs_not_available", "export_not_available", "path_escapes_export", "not_found", "wrong_kind", "io_error", "too_large", "ambiguous_export", "invalid_method", "invalid_response", "closed", "ambiguous_machine"]),
  message: z.string(),
}));
