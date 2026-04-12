import type { Gate, Plan } from "@openomni/protocol";
import { DAG } from "../dag/index.js";
import {
  computeMaxDepth,
  countWords,
  getErrorMessage,
  isNonEmpty,
  jaccardSimilarity,
} from "./plan-checks.js";

const DEFAULTS = {
  minDescriptionWords: 3,
  minExpectedOutputWords: 3,
  maxDependencyDepth: 10,
  duplicateThreshold: 0.85,
  requireGuardrail: false,
} as const;

export namespace StructuralGate {
  export interface Config {
    minDescriptionWords?: number;
    minExpectedOutputWords?: number;
    maxDependencyDepth?: number;
    duplicateThreshold?: number;
    requireGuardrail?: boolean;
  }

  export function evaluate(plan: Plan, config?: Config): Gate.Verdict {
    const c = { ...DEFAULTS, ...config };
    const issues: Gate.Issue[] = [];

    const dagCheck = checkDagValidity(plan, issues);
    const complete = checkFieldCompleteness(plan, c, issues);
    checkMinimumQuality(plan, c, complete, issues);

    if (dagCheck.valid && dagCheck.dag) {
      checkDuplicateSteps(plan, c, issues);
      const depth = computeMaxDepth(dagCheck.dag);
      if (depth > c.maxDependencyDepth) {
        issues.push({
          code: "deep_dependency_chain",
          severity: "warning",
          message: `Dependency depth ${depth} exceeds maximum ${c.maxDependencyDepth}`,
        });
      }
    }

    checkIsolatedSteps(plan, issues);
    return { passed: !issues.some((i) => i.severity === "error"), issues };
  }
}

export const structuralGateCheck: Gate.Check = {
  name: "structural",
  check: (plan: Plan) => StructuralGate.evaluate(plan),
};

type Cfg = Required<StructuralGate.Config>;

function checkDagValidity(
  plan: Plan,
  issues: Gate.Issue[],
): { valid: boolean; dag?: ReturnType<typeof DAG.build> } {
  let dag: ReturnType<typeof DAG.build>;
  try {
    dag = DAG.build(plan.steps);
  } catch (error) {
    issues.push({
      code: "invalid_dag",
      severity: "error",
      message: `Invalid DAG: ${getErrorMessage(error)}`,
    });
    return { valid: false };
  }
  const acyclic = DAG.validateAcyclic(dag);
  if (!acyclic.valid) {
    issues.push({
      code: "circular_dependency",
      severity: "error",
      message: `Circular dependency detected: ${acyclic.cycle.join(" -> ")}`,
    });
    return { valid: false, dag };
  }
  return { valid: true, dag };
}

function checkFieldCompleteness(plan: Plan, config: Cfg, issues: Gate.Issue[]): Set<string> {
  const complete = new Set<string>();
  for (const step of plan.steps) {
    let ok = true;
    if (!isNonEmpty(step.description)) {
      issues.push({
        code: "empty_field",
        severity: "error",
        stepId: step.stepId,
        message: `Step "${step.stepId}" has empty field: description`,
      });
      ok = false;
    }
    if (!isNonEmpty(step.expectedOutput)) {
      issues.push({
        code: "empty_field",
        severity: "error",
        stepId: step.stepId,
        message: `Step "${step.stepId}" has empty field: expectedOutput`,
      });
      ok = false;
    }
    if (config.requireGuardrail && !isNonEmpty(step.guardrail)) {
      issues.push({
        code: "missing_guardrail",
        severity: "error",
        stepId: step.stepId,
        message: `Step "${step.stepId}" is missing guardrail`,
      });
      ok = false;
    }
    if (ok) complete.add(step.stepId);
  }
  return complete;
}

function checkMinimumQuality(
  plan: Plan,
  config: Cfg,
  complete: Set<string>,
  issues: Gate.Issue[],
): void {
  for (const step of plan.steps) {
    if (!complete.has(step.stepId)) continue;
    const dw = countWords(step.description);
    if (dw < config.minDescriptionWords) {
      issues.push({
        code: "low_quality_description",
        severity: "warning",
        stepId: step.stepId,
        message: `Step "${step.stepId}" description has ${dw} words (minimum: ${config.minDescriptionWords})`,
      });
    }
    const ow = countWords(step.expectedOutput);
    if (ow < config.minExpectedOutputWords) {
      issues.push({
        code: "low_quality_expected_output",
        severity: "warning",
        stepId: step.stepId,
        message: `Step "${step.stepId}" expectedOutput has ${ow} words (minimum: ${config.minExpectedOutputWords})`,
      });
    }
  }
}

function checkDuplicateSteps(plan: Plan, config: Cfg, issues: Gate.Issue[]): void {
  for (let i = 0; i < plan.steps.length; i += 1) {
    for (let j = i + 1; j < plan.steps.length; j += 1) {
      const left = plan.steps[i];
      const right = plan.steps[j];
      if (!left || !right) continue;
      const sim = jaccardSimilarity(left.description, right.description);
      if (sim >= config.duplicateThreshold) {
        issues.push({
          code: "duplicate_steps",
          severity: "warning",
          message: `Potential duplicate steps: "${left.stepId}" and "${right.stepId}" (similarity: ${sim.toFixed(2)})`,
        });
      }
    }
  }
}

function checkIsolatedSteps(plan: Plan, issues: Gate.Issue[]): void {
  if (plan.steps.length < 2) return;
  const referenced = new Set<string>();
  for (const step of plan.steps) {
    for (const depId of step.dependsOn) referenced.add(depId);
  }
  for (const step of plan.steps) {
    if (step.dependsOn.length === 0 && !referenced.has(step.stepId)) {
      issues.push({
        code: "isolated_step",
        severity: "warning",
        stepId: step.stepId,
        message: `Step "${step.stepId}" is isolated from the dependency graph`,
      });
    }
  }
}
