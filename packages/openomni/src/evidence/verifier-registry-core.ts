import {
  type Obligation,
  type Registry,
  type SandboxCapability,
  type VerifierProgram,
  type VerificationError,
  type VerificationErrorCode,
  type VerificationFact,
  type VerificationResult,
  AssertedOnlyKind,
  Obligation as ObligationSchema,
  VerificationError as VerificationErrorSchema,
  VerificationRequest,
  VerificationResult as VerificationResultSchema,
} from "./verifier-registry-contract.js";
import { type Evaluation, evaluateObligation } from "./verifier-registry-evaluators.js";

const defaultProgram: VerifierProgram = Object.freeze({
  version: "verifier-program-v1" as const,
  outputVersion: "verification-fact-v1",
  capabilities: [],
  actions: [],
});

export function createRegistry(): Registry {
  return Object.freeze({
    verify(input: unknown): VerificationFact {
      const direct = ObligationSchema.safeParse(input);
      let obligation: Obligation;
      let program: VerifierProgram;
      if (direct.success) {
        obligation = direct.data;
        program = defaultProgram;
      } else {
        const wrapped = VerificationRequest.safeParse(input);
        if (!wrapped.success) {
          return error("malformed_input", "verification request failed schema validation");
        }
        obligation = wrapped.data.obligation;
        program = wrapped.data.program;
      }

      const capability = [...program.capabilities].sort(asciiCompare)[0];
      if (capability !== undefined) {
        return error(
          "prohibited_capability",
          "verifier programs have no ambient capabilities",
          obligation,
          undefined,
          capability,
        );
      }
      const action = [...program.actions].sort(asciiCompare)[0];
      if (action !== undefined) {
        return error(
          "forbidden_action",
          "verifier programs cannot perform live actions",
          obligation,
          undefined,
          action,
        );
      }
      if (program.outputVersion !== "verification-fact-v1") {
        return error("malformed_output", "requested output contract is not supported", obligation);
      }
      if (AssertedOnlyKind.safeParse(obligation.kind).success) {
        return result(obligation, {
          verifierId: "asserted-only",
          status: "asserted",
        });
      }

      try {
        const evaluated = evaluateObligation(obligation);
        return "type" in evaluated ? evaluated : result(obligation, evaluated);
      } catch {
        return error(
          "verifier_crash",
          "built-in verifier failed deterministic evaluation",
          obligation,
        );
      }
    },
  });
}

function result(obligation: Obligation, value: Evaluation): VerificationResult {
  return VerificationResultSchema.parse({
    type: "verification_result",
    obligationId: obligation.obligationId,
    kind: obligation.kind,
    verifierId: value.verifierId,
    status: value.status,
    checkedPredicate: value.checkedPredicate,
    modelFingerprint: value.modelFingerprint,
  });
}

function error(
  code: VerificationErrorCode,
  detail: string,
  obligation?: Obligation,
  verifierId?: string,
  violation?: SandboxCapability | VerifierProgram["actions"][number],
): VerificationError {
  return VerificationErrorSchema.parse({
    type: "verification_error",
    code,
    detail,
    obligationId: obligation?.obligationId,
    kind: obligation?.kind,
    verifierId,
    violation,
  });
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
