import type { PlanStep } from "@openomni/protocol";

export interface DAGStructure {
  nodes: Set<string>;
  edges: Map<string, Set<string>>;
  reverseEdges: Map<string, Set<string>>;
  pendingDeps: Map<string, number>;
}

type AcyclicResult = { valid: true } | { valid: false; cycle: string[] };

export namespace DAG {
  export function build(steps: PlanStep[]): DAGStructure {
    const nodes = new Set<string>();
    const edges = new Map<string, Set<string>>();
    const reverseEdges = new Map<string, Set<string>>();
    const pendingDeps = new Map<string, number>();

    for (const step of steps) {
      if (nodes.has(step.stepId)) {
        throw new Error(`Duplicate step id: ${step.stepId}`);
      }

      nodes.add(step.stepId);
      edges.set(step.stepId, new Set(step.dependsOn));
      reverseEdges.set(step.stepId, new Set());
      pendingDeps.set(step.stepId, step.dependsOn.length);
    }

    for (const step of steps) {
      for (const dependencyId of step.dependsOn) {
        if (!nodes.has(dependencyId)) {
          throw new Error(
            `Step "${step.stepId}" depends on unknown step "${dependencyId}"`,
          );
        }

        const dependents = reverseEdges.get(dependencyId);
        if (!dependents) {
          continue;
        }

        dependents.add(step.stepId);
      }
    }

    return {
      nodes,
      edges,
      reverseEdges,
      pendingDeps,
    };
  }

  export function validateAcyclic(dag: DAGStructure): AcyclicResult {
    const inDegree = new Map<string, number>(dag.pendingDeps.entries());
    const queue: string[] = [];

    for (const nodeId of dag.nodes) {
      const degree = inDegree.get(nodeId) ?? 0;
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    let visited = 0;

    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) {
        continue;
      }

      visited += 1;
      const dependents = dag.reverseEdges.get(nodeId) ?? new Set<string>();
      for (const dependentId of dependents) {
        const degree = inDegree.get(dependentId);
        if (degree === undefined) {
          continue;
        }

        const nextDegree = degree - 1;
        inDegree.set(dependentId, nextDegree);
        if (nextDegree === 0) {
          queue.push(dependentId);
        }
      }
    }

    if (visited === dag.nodes.size) {
      return { valid: true };
    }

    const remaining = new Set<string>();
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree > 0) {
        remaining.add(nodeId);
      }
    }

    return {
      valid: false,
      cycle: findCycle(remaining, dag.reverseEdges),
    };
  }

  export function getReady(
    dag: DAGStructure,
    completed: Set<string>,
  ): string[] {
    const ready: string[] = [];
    for (const nodeId of dag.nodes) {
      if (completed.has(nodeId)) {
        continue;
      }

      const dependencies = dag.edges.get(nodeId) ?? new Set<string>();
      let allResolved = true;
      for (const depId of dependencies) {
        if (!completed.has(depId)) {
          allResolved = false;
          break;
        }
      }

      if (allResolved) {
        ready.push(nodeId);
      }
    }

    return ready;
  }

  export function complete(
    dag: DAGStructure,
    stepId: string,
    completed: Set<string>,
  ): { newlyReady: string[] } {
    if (!dag.nodes.has(stepId) || completed.has(stepId)) {
      return { newlyReady: [] };
    }

    const completedWithStep = new Set<string>(completed);
    completedWithStep.add(stepId);

    const newlyReady: string[] = [];
    const dependents = dag.reverseEdges.get(stepId) ?? new Set<string>();
    for (const dependentId of dependents) {
      if (completedWithStep.has(dependentId)) {
        continue;
      }

      const dependencies = dag.edges.get(dependentId) ?? new Set<string>();
      let allResolved = true;
      for (const dependencyId of dependencies) {
        if (!completedWithStep.has(dependencyId)) {
          allResolved = false;
          break;
        }
      }

      if (allResolved) {
        newlyReady.push(dependentId);
      }
    }

    return { newlyReady };
  }
}

function findCycle(
  nodes: Set<string>,
  adjacency: Map<string, Set<string>>,
): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (nodeId: string): string[] | undefined => {
    visiting.add(nodeId);
    stack.push(nodeId);

    const neighbors = adjacency.get(nodeId) ?? new Set<string>();
    for (const neighborId of neighbors) {
      if (!nodes.has(neighborId)) {
        continue;
      }

      if (visiting.has(neighborId)) {
        const start = stack.indexOf(neighborId);
        const cycle = stack.slice(start);
        cycle.push(neighborId);
        return cycle;
      }

      if (!visited.has(neighborId)) {
        const found = visit(neighborId);
        if (found) {
          return found;
        }
      }
    }

    visiting.delete(nodeId);
    visited.add(nodeId);
    stack.pop();
    return undefined;
  };

  for (const nodeId of nodes) {
    if (visited.has(nodeId)) {
      continue;
    }

    const cycle = visit(nodeId);
    if (cycle) {
      return cycle;
    }
  }

  return [];
}
