import { Data } from "effect";
import { z } from "zod";

const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
/** Codemode-owned failure for a Cause without a typed error (temporary until #1246 folds codemode into machines). */
export class CodemodeFailure extends Data.TaggedError("CodemodeFailure")<z.infer<typeof Diagnostic>> {
  override get message(): string { return this.cause; }
}
const Fields = z.object({
  reason: z.enum(["closed", "machines_not_bound", "machine_not_found", "ambiguous_machine", "unknown_cell_id"]),
  message: z.string(),
});
export class CodemodeError extends Data.TaggedError("CodemodeError")<z.infer<typeof Fields>> {}
const DriverFields = Diagnostic.extend({ message: z.string() });
export class DriverFailure extends Data.TaggedError("DriverFailure")<z.infer<typeof DriverFields>> {}
export type CodeError = CodemodeError | CodemodeFailure | DriverFailure;
