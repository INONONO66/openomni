import type { Plan } from "@openomni/protocol";
import { DAG } from "../dag/index.js";

export type SpecStrictness = "strict" | "lenient" | "off";

export interface SpecIssue {
  code:
    | "circular_dependency"
    | "missing_expected_output"
    | "missing_guardrail"
    | "dangling_dependency"
    | "duplicate_step_id";
  stepId?: string;
  message: string;
}

export interface SpecValidationResult {
  valid: boolean;
  issues: SpecIssue[];
}

/** @deprecated Use StructuralGate from "./structural-gate.js" instead. */
export namespace SpecValidator {
  export function validate(
    plan: Plan,
    options?: { strictness?: SpecStrictness },
  ): SpecValidationResult {
    const strictness = options?.strictness ?? "lenient";
    if (strictness === "off") return { valid: true, issues: [] };

    const issues: SpecIssue[] = [];
    const stepIds = plan.steps.map((s) => s.stepId);
    const stepIdSet = new Set(stepIds);
    const seen = new Set<string>();
    for (const id of stepIds) {
      if (seen.has(id))
        issues.push({
          code: "duplicate_step_id",
          stepId: id,
          message: `Duplicate step ID: "${id}"`,
        });
      seen.add(id);
    }

    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        if (!stepIdSet.has(dep))
          issues.push({
            code: "dangling_dependency",
            stepId: step.stepId,
            message: `Step "${step.stepId}" depends on non-existent step "${dep}"`,
          });
      }
    }

    if (issues.length === 0) {
      try {
        const dag = DAG.build(plan.steps);
        const acyclic = DAG.validateAcyclic(dag);
        if (!acyclic.valid)
          issues.push({
            code: "circular_dependency",
            message: `Circular dependency detected: ${acyclic.cycle.join(" → ")}`,
          });
      } catch {
        issues.push({
          code: "circular_dependency",
          message: "Failed to build DAG — possible circular or invalid dependencies",
        });
      }
    }

    if (strictness === "strict") {
      for (const step of plan.steps) {
        if (!step.expectedOutput || step.expectedOutput.trim() === "") {
          issues.push({
            code: "missing_expected_output",
            stepId: step.stepId,
            message: `Step "${step.stepId}" is missing expectedOutput (required in strict mode)`,
          });
        }
        if (!step.guardrail || step.guardrail.trim() === "") {
          issues.push({
            code: "missing_guardrail",
            stepId: step.stepId,
            message: `Step "${step.stepId}" is missing a guardrail (required in strict mode)`,
          });
        }
      }
    }

    return { valid: issues.length === 0, issues };
  }
}
