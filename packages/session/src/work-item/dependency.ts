import { WorkItem } from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import type { DependencyReadiness, WorkItemAdapter } from "./types.js";

export function areWorkItemDependenciesMet(hash: string): DependencyReadiness {
  const workItem = Storage.get().workItem;
  if (!workItem) return { met: false, reason: "pending" };

  const item = workItem.get(hash);
  if (!item) return { met: false, reason: "pending" };
  if (item.relations.dependsOn.length === 0) {
    return { met: true, reason: "all_complete" };
  }

  for (const dependencyHash of item.relations.dependsOn) {
    const dependency = workItem.get(dependencyHash);
    if (!dependency) return { met: false, reason: "pending" };

    const status = WorkItem.deriveStatus(dependency);
    if (status === "failed") return { met: false, reason: "failed" };
    if (status === "blocked") return { met: false, reason: "blocked" };
    if (status !== "completed") return { met: false, reason: "pending" };
  }

  return { met: true, reason: "all_complete" };
}

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
