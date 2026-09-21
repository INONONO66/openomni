import { Data } from "effect";
import { z } from "zod";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
export class ForeignFailure extends Data.TaggedError("ForeignFailure")<z.infer<typeof Diagnostic>> {
  override get message(): string { return this.cause; }
}
const Fields = z.object({
  reason: z.enum(["closed", "machines_not_bound", "machine_not_found", "ambiguous_machine", "unknown_cell_id"]),
  message: z.string(),
});
export class CodemodeError extends Data.TaggedError("CodemodeError")<z.infer<typeof Fields>> {}
const DriverFields = Diagnostic.extend({ message: z.string() });
export class DriverFailure extends Data.TaggedError("DriverFailure")<z.infer<typeof DriverFields>> {}
export type CodeError = CodemodeError | ForeignFailure | DriverFailure;
