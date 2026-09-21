import type { PlainObject } from "@openomni/protocol";
import { Cause, Chunk } from "effect";
import type { ExecutionError } from "./errors";

export function failureEvidence(error: ExecutionError): PlainObject {
  switch (error._tag) {
    case "PolicyDenied":
      return { tag: error._tag, phase: error.phase, ruleIds: [...error.ruleIds] };
    case "ToolBodyFailed":
      return { tag: error._tag, tool: error.tool, cause: error.cause };
    case "ForeignFailure":
      return { tag: error._tag, operation: error.operation, cause: error.cause };
    case "CommitFailed":
      return { tag: error._tag, ledgerTag: error.error._tag, cause: String(error.error) };
    case "ExecutionApprovalError":
      return { tag: error._tag, code: error.code };
    case "OutcomeUnknown":
      return { tag: error._tag, reason: error.reason };
    case "Interrupted":
      return { tag: error._tag };
  }
}

export function causeEvidence(cause: Cause.Cause<ExecutionError>): PlainObject {
  return {
    failures: Chunk.toReadonlyArray(Cause.failures(cause)).map(failureEvidence),
    defects: Cause.isDie(cause)
      ? Cause.prettyErrors(Cause.stripFailures(cause)).map((error) => ({
          name: error.name,
          cause: error.message,
        }))
      : [],
    interrupted: Cause.isInterrupted(cause),
  };
}
