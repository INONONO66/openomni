import type { ForeignFailure } from "@openomni/machines";
import { Data } from "effect";
import { z } from "zod";

export { ForeignFailure } from "@openomni/machines";

/** Codemode-owned failure for a Cause without a typed error (temporary until #1246 folds codemode into machines). */
export class CodemodeFailure extends Data.TaggedError("CodemodeFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return this.cause; }
}
const Diagnostic = z.object({ operation: z.string(), cause: z.string() });
const Fields = z.object({
  reason: z.enum(["closed", "machines_not_bound", "machine_not_found", "ambiguous_machine", "unknown_cell_id"]),
  message: z.string(),
});
export class CodemodeError extends Data.TaggedError("CodemodeError")<z.infer<typeof Fields>> {}
const DriverFields = Diagnostic.extend({ message: z.string() });
export class DriverFailure extends Data.TaggedError("DriverFailure")<z.infer<typeof DriverFields>> {}
export type CodeError = CodemodeError | ForeignFailure | DriverFailure;
