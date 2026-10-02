import type { PlainObject } from "@openomni/protocol";
import { Cause } from "effect";
import type { ExecutionError } from "./errors";

export function failureEvidence(error: ExecutionError): PlainObject {
  switch (error._tag) {
    case "LlmRunFailure":
      return {
        tag: error._tag,
        message: error.message,
        providerErrorName: typeof error.cause === "object" ? error.cause.name : null,
        retryAfterMs: error.retryAfterMs ?? null,
        usage: error.usage,
        aborted: error.aborted,
        contextOverflow: error.contextOverflow,
        visibleOutput: error.visibleOutput,
        cause: typeof error.cause === "object" ? error.cause.message : error.cause ?? null,
      };
    case "PolicyDenied":
      return { tag: error._tag, phase: error.phase, ruleIds: [...error.ruleIds] };
    case "ToolBodyFailed":
      return { tag: error._tag, tool: error.tool, cause: error.cause };
    case "InvocationClosed":
      return { tag: error._tag, tool: error.tool, reason: error.reason };
    case "GenerationUnavailable":
      return { tag: error._tag, generation: error.generation };
    case "AgentFailure":
      return { tag: error._tag, operation: error.operation, cause: error.cause };
    case "CompactionExecutionError":
      return { tag: error._tag, reason: error.reason };
    case "CommitFailed":
      return { tag: error._tag, ledgerTag: error.error._tag, cause: String(error.error) };
    case "ExecutionApprovalError":
      return { tag: error._tag, code: error.code };
    case "OutcomeUnknown":
      return { tag: error._tag, reason: error.reason };
    case "Interrupted":
      return { tag: error._tag };
    case "ContextAdmissionError":
      return { tag: error._tag };
    case "AgentStopError":
      return { tag: error._tag, code: error.code, reason: error.reason };
  }
}

export function causeEvidence(cause: Cause.Cause<ExecutionError>): PlainObject {
  return {
    failures: cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error).map(failureEvidence),
    defects: Cause.hasDies(cause)
      ? Cause.prettyErrors(Cause.fromReasons(cause.reasons.filter(Cause.isDieReason))).map((error) => ({
          name: error.name,
          cause: error.message,
        }))
      : [],
    interrupted: Cause.hasInterrupts(cause),
  };
}
