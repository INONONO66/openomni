import { Machine } from "@openomni/protocol";
import { Data } from "effect";
import { z } from "zod";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
export class ForeignFailure extends Data.TaggedError("ForeignFailure")<z.infer<typeof Diagnostic>> {
  override get message(): string { return this.cause; }
}
const CellFields = Machine.CellRequest.pick({ cellId: true }).extend({
  code: z.enum(["duplicate_cell_id", "unknown_cell_id"]),
  message: z.string(),
});
export class MachineCellError extends Data.TaggedError("MachineCellError")<z.infer<typeof CellFields>> {}
const RefusalFields = z.object({
  reason: z.enum([
    "machine_not_attached", "fs_not_available", "export_not_available", "path_escapes_export",
    "not_found", "wrong_kind", "io_error", "too_large", "ambiguous_export", "invalid_method",
    "invalid_response", "closed", "ambiguous_machine",
  ]),
  message: z.string(),
});
export class MachineRefusalError extends Data.TaggedError("MachineRefusalError")<z.infer<typeof RefusalFields>> {}
const BoundaryFields = Diagnostic.extend({ message: z.string() });
export class SpawnFailure extends Data.TaggedError("SpawnFailure")<z.infer<typeof BoundaryFields>> {}
export class FilesystemFailure extends Data.TaggedError("FilesystemFailure")<z.infer<typeof BoundaryFields>> {}
export class TransportFailure extends Data.TaggedError("TransportFailure")<z.infer<typeof BoundaryFields>> {}

export type MachineError = ForeignFailure | MachineCellError | MachineRefusalError | SpawnFailure | FilesystemFailure | TransportFailure;
