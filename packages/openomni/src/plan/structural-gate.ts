import type { Gate, Plan } from "@openomni/protocol";
import { DAG } from "../dag/index.js";

const DEFAULT_MIN_DESCRIPTION_WORDS = 3;
const DEFAULT_MIN_EXPECTED_OUTPUT_WORDS = 3;
const DEFAULT_MAX_DEPENDENCY_DEPTH = 10;
const DEFAULT_DUPLICATE_THRESHOLD = 0.85;
const DEFAULT_REQUIRE_GUARDRAIL = false;

export namespace StructuralGate {
  export interface Config {
    minDescriptionWords?: number;
    minExpectedOutputWords?: number;
    maxDependencyDepth?: number;
    duplicateThreshold?: number;
    requireGuardrail?: boolean;
  }

  export function evaluate(plan: Plan, config?: Config): Gate.Verdict {
    const resolved = resolveConfig(config);
    const issues: Gate.Issue[] = [];

    const dagCheck = checkDagValidity(plan, issues);
    const completeStepIds = checkFieldCompleteness(plan, resolved, issues);
    checkStepMinimumQuality(plan, resolved, completeStepIds, issues);

    if (dagCheck.valid && dagCheck.dag) {
      checkDuplicateSteps(plan, resolved, issues);
      checkDependencyDepth(dagCheck.dag, resolved, issues);
    }

    checkIsolatedSteps(plan, issues);

    return {
      passed: !issues.some((issue) => issue.severity === "error"),
      issues,
    };
  }
}

export const structuralGateCheck: Gate.Check = {
  name: "structural",
  check(plan: Plan, _context: Gate.Context): Gate.Verdict {
    return StructuralGate.evaluate(plan);
  },
};

function resolveConfig(
  config?: StructuralGate.Config,
): Required<StructuralGate.Config> {
  return {
    minDescriptionWords:
      config?.minDescriptionWords ?? DEFAULT_MIN_DESCRIPTION_WORDS,
    minExpectedOutputWords:
      config?.minExpectedOutputWords ?? DEFAULT_MIN_EXPECTED_OUTPUT_WORDS,
    maxDependencyDepth:
      config?.maxDependencyDepth ?? DEFAULT_MAX_DEPENDENCY_DEPTH,
    duplicateThreshold:
      config?.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD,
    requireGuardrail: config?.requireGuardrail ?? DEFAULT_REQUIRE_GUARDRAIL,
  };
}

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

function checkFieldCompleteness(
  plan: Plan,
  config: Required<StructuralGate.Config>,
  issues: Gate.Issue[],
): Set<string> {
  const completeStepIds = new Set<string>();

  for (const step of plan.steps) {
    let complete = true;

    if (!isNonEmpty(step.description)) {
      issues.push({
        code: "empty_field",
        severity: "error",
        stepId: step.stepId,
        message: `Step "${step.stepId}" has empty field: description`,
      });
      complete = false;
    }

    if (!isNonEmpty(step.expectedOutput)) {
      issues.push({
        code: "empty_field",
        severity: "error",
        stepId: step.stepId,
        message: `Step "${step.stepId}" has empty field: expectedOutput`,
      });
      complete = false;
    }

    if (config.requireGuardrail && !isNonEmpty(step.guardrail)) {
      issues.push({
        code: "missing_guardrail",
        severity: "error",
        stepId: step.stepId,
        message: `Step "${step.stepId}" is missing guardrail`,
      });
      complete = false;
    }

    if (complete) {
      completeStepIds.add(step.stepId);
    }
  }

  return completeStepIds;
}

function checkStepMinimumQuality(
  plan: Plan,
  config: Required<StructuralGate.Config>,
  completeStepIds: Set<string>,
  issues: Gate.Issue[],
): void {
  for (const step of plan.steps) {
    if (!completeStepIds.has(step.stepId)) {
      continue;
    }

    const descriptionWords = countWords(step.description);
    if (descriptionWords < config.minDescriptionWords) {
      issues.push({
        code: "low_quality_description",
        severity: "warning",
        stepId: step.stepId,
        message: `Step "${step.stepId}" description has ${descriptionWords} words (minimum: ${config.minDescriptionWords})`,
      });
    }

    const expectedOutputWords = countWords(step.expectedOutput);
    if (expectedOutputWords < config.minExpectedOutputWords) {
      issues.push({
        code: "low_quality_expected_output",
        severity: "warning",
        stepId: step.stepId,
        message: `Step "${step.stepId}" expectedOutput has ${expectedOutputWords} words (minimum: ${config.minExpectedOutputWords})`,
      });
    }
  }
}

function checkDuplicateSteps(
  plan: Plan,
  config: Required<StructuralGate.Config>,
  issues: Gate.Issue[],
): void {
  for (let i = 0; i < plan.steps.length; i += 1) {
    for (let j = i + 1; j < plan.steps.length; j += 1) {
      const left = plan.steps[i];
      const right = plan.steps[j];
      if (!left || !right) {
        continue;
      }

      const similarity = jaccardSimilarity(left.description, right.description);
      if (similarity >= config.duplicateThreshold) {
        issues.push({
          code: "duplicate_steps",
          severity: "warning",
          message: `Potential duplicate steps: "${left.stepId}" and "${right.stepId}" (similarity: ${similarity.toFixed(2)})`,
        });
      }
    }
  }
}

function checkDependencyDepth(
  dag: ReturnType<typeof DAG.build>,
  config: Required<StructuralGate.Config>,
  issues: Gate.Issue[],
): void {
  const depthByNode = new Map<string, number>();
  const inDegree = new Map<string, number>(dag.pendingDeps.entries());
  const queue: string[] = [];

  for (const nodeId of dag.nodes) {
    const degree = inDegree.get(nodeId) ?? 0;
    if (degree === 0) {
      depthByNode.set(nodeId, 0);
      queue.push(nodeId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const currentDepth = depthByNode.get(current) ?? 0;
    const dependents = dag.reverseEdges.get(current) ?? new Set<string>();

    for (const dependent of dependents) {
      const nextDepth = currentDepth + 1;
      const previousDepth = depthByNode.get(dependent) ?? 0;
      if (nextDepth > previousDepth) {
        depthByNode.set(dependent, nextDepth);
      }

      const degree = inDegree.get(dependent);
      if (degree === undefined) {
        continue;
      }

      const reduced = degree - 1;
      inDegree.set(dependent, reduced);
      if (reduced === 0) {
        queue.push(dependent);
      }
    }
  }

  let maxDepth = 0;
  for (const depth of depthByNode.values()) {
    if (depth > maxDepth) {
      maxDepth = depth;
    }
  }

  if (maxDepth > config.maxDependencyDepth) {
    issues.push({
      code: "deep_dependency_chain",
      severity: "warning",
      message: `Dependency depth ${maxDepth} exceeds maximum ${config.maxDependencyDepth}`,
    });
  }
}

function checkIsolatedSteps(plan: Plan, issues: Gate.Issue[]): void {
  if (plan.steps.length < 2) {
    return;
  }

  const referenced = new Set<string>();
  for (const step of plan.steps) {
    for (const depId of step.dependsOn) {
      referenced.add(depId);
    }
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

function countWords(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0;
  }

  return trimmed.split(/\s+/).filter(Boolean).length;
}

function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  return new Set(words);
}

function jaccardSimilarity(left: string, right: string): number {
  const leftSet = tokenize(left);
  const rightSet = tokenize(right);

  if (leftSet.size === 0 && rightSet.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const union = leftSet.size + rightSet.size - intersection;
  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown DAG build error";
}
