import type { WorkItemAdapter } from "./types.js";

export function detectCycles(
  adapter: WorkItemAdapter,
  startHashes: string[],
  visited: Set<string>,
): void {
  for (const dependencyHash of startHashes) {
    if (visited.has(dependencyHash)) {
      throw new Error(
        `Circular dependency detected: ${dependencyHash} is already in the dependency chain`,
      );
    }

    const dependency = adapter.get(dependencyHash);
    if (dependency && dependency.relations.dependsOn.length > 0) {
      detectCycles(adapter, dependency.relations.dependsOn, new Set([...visited, dependencyHash]));
    }
  }
}
