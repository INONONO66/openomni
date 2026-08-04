import { z } from "zod";
import { snapshotFirstJsonSchema } from "../evidence/verifier-conformance-canonical.js";
import { createStakesSchemas, type StakesValue as StakesValueType } from "./stakes-contract.js";

const AssessmentSchemas = createStakesSchemas();
const assessmentInput = snapshotFirstJsonSchema(
  z
    .object({
      result: AssessmentSchemas.StakesCriterionResult,
      stakes: z.unknown(),
      policyAllowsLowAsserted: z.boolean().default(false),
    })
    .strict(),
);

export type StakesCriterionAssessment =
  | {
      readonly treatment: "eligible_input";
      readonly reason: "verified_input";
      readonly authorizes: false;
    }
  | {
      readonly treatment: "residual_risk";
      readonly reason: "low_stakes_asserted";
      readonly authorizes: false;
    }
  | {
      readonly treatment: "owner_required";
      readonly reason: "high_stakes_asserted";
      readonly authorizes: false;
    }
  | {
      readonly treatment: "non_passing";
      readonly reason:
        | "low_stakes_asserted_not_permitted"
        | "missing"
        | "refuted"
        | "inconclusive"
        | "invalidated"
        | "basis_mismatched"
        | "verification_error";
      readonly authorizes: false;
    };

export function assessStakesCriterion(input: unknown): StakesCriterionAssessment {
  const parsed = assessmentInput.parse(input);
  const stakes = AssessmentSchemas.StakesValue.parse(parsed.stakes);
  return Object.freeze(
    assessIssuedCriterion(parsed.result, stakes, parsed.policyAllowsLowAsserted),
  );
}

function assessIssuedCriterion(
  result: z.infer<typeof AssessmentSchemas.StakesCriterionResult>,
  stakes: StakesValueType,
  policyAllowsLowAsserted: boolean,
): StakesCriterionAssessment {
  switch (result) {
    case "verified":
      return { treatment: "eligible_input", reason: "verified_input", authorizes: false };
    case "asserted":
      if (stakes.comparison !== "below") {
        return {
          treatment: "owner_required",
          reason: "high_stakes_asserted",
          authorizes: false,
        };
      }
      if (policyAllowsLowAsserted) {
        return {
          treatment: "residual_risk",
          reason: "low_stakes_asserted",
          authorizes: false,
        };
      }
      return nonPassing("low_stakes_asserted_not_permitted");
    case "missing":
    case "refuted":
    case "inconclusive":
    case "invalidated":
    case "basis_mismatched":
    case "verification_error":
      return nonPassing(result);
    default:
      return unexpectedCriterionResult(result);
  }
}

function nonPassing(
  reason: Extract<StakesCriterionAssessment, { treatment: "non_passing" }>["reason"],
): StakesCriterionAssessment {
  return { treatment: "non_passing", reason, authorizes: false };
}

function unexpectedCriterionResult(result: never): never {
  throw new StakesAssessmentError(result);
}

class StakesAssessmentError extends Error {
  readonly name = "StakesAssessmentError";

  constructor(readonly result: never) {
    super("unexpected Stakes criterion result");
  }
}
