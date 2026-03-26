import { BuiltinAgentRegistry } from "../../agent";
import type { DependencyGraph, DispatchTask, DispatchTaskState } from "../execution-types";

export function buildDependencyGraph(tasks: DispatchTask[]): DependencyGraph {
  const states = new Map<string, DispatchTaskState>();
  const pendingDependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (states.has(task.id)) {
      throw new Error(`Duplicate task id in dispatch input: ${task.id}`);
    }

    const agent = BuiltinAgentRegistry.get(task.agentType);
    if (!agent) {
      throw new Error(`Unknown agent type in dispatch task "${task.id}": ${task.agentType}`);
    }

    states.set(task.id, {
      task,
      childTaskId: "",
      status: "pending",
      sessionId: "",
      agentInstanceId: "",
      agentHistory: [],
      attempts: 0,
      rejectionStreak: 0,
      totalRejections: 0,
      handoffs: 0,
      summaries: [],
      feedbackHistory: [],
      errors: [],
    });
    pendingDependencies.set(task.id, new Set(task.dependencies));
    dependents.set(task.id, new Set<string>());
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!states.has(dependencyId)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dependencyId}"`);
      }

      const dependencyDependents = dependents.get(dependencyId);
      if (!dependencyDependents) {
        continue;
      }
      dependencyDependents.add(task.id);
    }
  }

  assertAcyclicDependencyGraph(pendingDependencies, dependents);

  return {
    states,
    pendingDependencies,
    dependents,
  };
}

export function completeTaskAndUnblockDependents(
  graph: DependencyGraph,
  taskId: string,
  completed: Set<string>,
  ready: Set<string>,
): void {
  const state = graph.states.get(taskId);
  if (!state) {
    return;
  }

  state.status = "completed";
  state.rejectionStreak = 0;
  completed.add(taskId);

  const dependents = graph.dependents.get(taskId) ?? new Set<string>();
  for (const dependentTaskId of dependents) {
    const remaining = graph.pendingDependencies.get(dependentTaskId);
    remaining?.delete(taskId);
    if (remaining && remaining.size === 0) {
      ready.add(dependentTaskId);
    }
  }
}

function assertAcyclicDependencyGraph(
  pendingDependencies: Map<string, Set<string>>,
  dependents: Map<string, Set<string>>,
): void {
  const inDegree = new Map<string, number>();
  for (const [taskId, deps] of pendingDependencies.entries()) {
    inDegree.set(taskId, deps.size);
  }

  const queue: string[] = [];
  for (const [taskId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    visited += 1;
    const currentDependents = dependents.get(current) ?? new Set<string>();
    for (const dependent of currentDependents) {
      const degree = inDegree.get(dependent);
      if (degree === undefined) {
        continue;
      }

      const nextDegree = degree - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (visited !== pendingDependencies.size) {
    throw new Error("Dispatch task dependency graph contains a cycle");
  }
}

export namespace FileLock {
  const locks = new Map<string, string>();

  export function acquire(filePath: string, agentId: string): boolean {
    const owner = locks.get(filePath);
    if (owner && owner !== agentId) {
      return false;
    }
    locks.set(filePath, agentId);
    return true;
  }

  export function release(filePath: string, agentId: string): boolean {
    const owner = locks.get(filePath);
    if (!owner || owner !== agentId) {
      return false;
    }
    locks.delete(filePath);
    return true;
  }

  export function owner(filePath: string): string | undefined {
    return locks.get(filePath);
  }

  export function clear(): void {
    locks.clear();
  }
}
