import type { DAG } from "../dag/index.js";

export function countWords(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

export function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  return new Set(normalized.split(/\s+/).filter(Boolean));
}

export function jaccardSimilarity(left: string, right: string): number {
  const leftSet = tokenize(left);
  const rightSet = tokenize(right);

  if (leftSet.size === 0 && rightSet.size === 0) return 1;

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** BFS topological traversal to find longest dependency chain. */
export function computeMaxDepth(dag: ReturnType<typeof DAG.build>): number {
  const depthByNode = new Map<string, number>();
  const inDegree = new Map<string, number>(dag.pendingDeps.entries());
  const queue: string[] = [];

  for (const nodeId of dag.nodes) {
    if ((inDegree.get(nodeId) ?? 0) === 0) {
      depthByNode.set(nodeId, 0);
      queue.push(nodeId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentDepth = depthByNode.get(current) ?? 0;

    for (const dependent of dag.reverseEdges.get(current) ?? new Set<string>()) {
      const nextDepth = currentDepth + 1;
      if (nextDepth > (depthByNode.get(dependent) ?? 0)) {
        depthByNode.set(dependent, nextDepth);
      }

      const degree = inDegree.get(dependent);
      if (degree === undefined) continue;

      const reduced = degree - 1;
      inDegree.set(dependent, reduced);
      if (reduced === 0) queue.push(dependent);
    }
  }

  let maxDepth = 0;
  for (const depth of depthByNode.values()) {
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

export function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown DAG build error";
}
