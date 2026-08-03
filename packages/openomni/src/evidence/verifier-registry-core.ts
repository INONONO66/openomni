import {
  type Obligation,
  type Registry,
  type SandboxCapability,
  type VerifierProgram,
  type VerificationError,
  type VerificationErrorCode,
  type VerificationFact,
  AssertedOnlyKind,
  Obligation as ObligationSchema,
  VerificationError as VerificationErrorSchema,
  VerificationRequest,
  VerificationResult as VerificationResultSchema,
} from "./verifier-registry-contract.js";
import { hashCanonicalJson } from "./verifier-conformance-canonical.js";
import { type Evaluation, evaluateObligation } from "./verifier-registry-evaluators.js";

type ResultValue =
  | Evaluation
  | Readonly<{
      verifierId: "asserted-only";
      status: "asserted";
      checkedPredicate?: undefined;
      modelFingerprint?: undefined;
    }>;

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
        return error("malformed_input", "requested output contract is not supported", obligation);
      }
      if (AssertedOnlyKind.safeParse(obligation.kind).success) {
        return result(obligation, {
          verifierId: "asserted-only",
          status: "asserted",
        });
      }

      let evaluated: Evaluation | VerificationError;
      try {
        evaluated = evaluateObligation(obligation);
      } catch {
        return error(
          "verifier_crash",
          "built-in verifier failed deterministic evaluation",
          obligation,
        );
      }
      return "type" in evaluated ? evaluated : result(obligation, evaluated);
    },
  });
}

function result(obligation: Obligation, value: ResultValue): VerificationFact {
  const parsed = VerificationResultSchema.safeParse({
    type: "verification_result",
    obligationId: obligation.obligationId,
    kind: obligation.kind,
    verifierId: value.verifierId,
    status: value.status,
    basisHash: hashCanonicalJson({
      version: "verification-basis-v1",
      obligation,
      verifierId: value.verifierId,
      ...(value.modelFingerprint === undefined ? {} : { modelFingerprint: value.modelFingerprint }),
    }),
    checkedPredicate: value.checkedPredicate,
    modelFingerprint: value.modelFingerprint,
  });
  return parsed.success
    ? parsed.data
    : error(
        "malformed_output",
        "built-in verifier result failed the output contract",
        obligation,
        value.verifierId,
      );
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
