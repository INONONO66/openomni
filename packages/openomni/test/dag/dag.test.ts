import { describe, expect, it } from "bun:test";
import type { Plan } from "@openomni/protocol";
import { DAG } from "../../src/dag";

function step(stepId: string, dependsOn: string[] = []): Plan.Step {
  return {
    stepId,
    description: `Step ${stepId}`,
    expectedOutput: `Output ${stepId}`,
    dependsOn,
  };
}

describe("DAG", () => {
  it("builds empty DAG and getReady returns empty", () => {
    const dag = DAG.build([]);

    expect(dag.nodes.size).toBe(0);
    expect(dag.edges.size).toBe(0);
    expect(dag.reverseEdges.size).toBe(0);
    expect(dag.pendingDeps.size).toBe(0);
    expect(DAG.getReady(dag, new Set())).toEqual([]);
  });

  it("returns single step as ready when there are no dependencies", () => {
    const dag = DAG.build([step("A")]);

    expect(DAG.getReady(dag, new Set())).toEqual(["A"]);
  });

  it("unblocks linear chain A -> B -> C", () => {
    const dag = DAG.build([step("A"), step("B", ["A"]), step("C", ["B"])]);
    const completed = new Set<string>();

    expect(DAG.getReady(dag, completed)).toEqual(["A"]);

    expect(DAG.complete(dag, "A", completed)).toEqual({ newlyReady: ["B"] });
    const completedAfterA = new Set<string>([...completed, "A"]);
    expect(DAG.complete(dag, "B", completedAfterA)).toEqual({
      newlyReady: ["C"],
    });
  });

  it("returns all independent steps as ready", () => {
    const dag = DAG.build([step("A"), step("B"), step("C")]);

    expect(DAG.getReady(dag, new Set())).toEqual(["A", "B", "C"]);
  });

  it("unblocks diamond DAG only after both prerequisites complete", () => {
    const dag = DAG.build([step("A"), step("B", ["A"]), step("C", ["A"]), step("D", ["B", "C"])]);
    const completed = new Set<string>();

    expect(DAG.getReady(dag, completed)).toEqual(["A"]);
    expect(DAG.complete(dag, "A", completed)).toEqual({
      newlyReady: ["B", "C"],
    });

    const completedWithA = new Set<string>(["A"]);
    expect(DAG.complete(dag, "B", completedWithA)).toEqual({ newlyReady: [] });

    const completedWithAB = new Set<string>(["A", "B"]);
    expect(DAG.complete(dag, "C", completedWithAB)).toEqual({
      newlyReady: ["D"],
    });
  });

  it("detects cycle A -> B -> C -> A", () => {
    const dag = DAG.build([step("A", ["C"]), step("B", ["A"]), step("C", ["B"])]);

    expect(DAG.validateAcyclic(dag)).toEqual({
      valid: false,
      cycle: ["A", "B", "C", "A"],
    });
  });

  it("detects self cycle A -> A", () => {
    const dag = DAG.build([step("A", ["A"])]);
    const result = DAG.validateAcyclic(dag);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.cycle.length).toBeGreaterThanOrEqual(2);
      expect(result.cycle[0]).toBe("A");
      expect(result.cycle[result.cycle.length - 1]).toBe("A");
    }
  });

  it("does not mutate completed input set in complete", () => {
    const dag = DAG.build([step("A"), step("B", ["A"])]);
    const completed = new Set<string>();

    const result = DAG.complete(dag, "A", completed);

    expect(completed.size).toBe(0);
    expect(result).toEqual({ newlyReady: ["B"] });
  });

  it("does not mutate DAGStructure in getReady", () => {
    const dag = DAG.build([step("A"), step("B", ["A"])]);
    const nodesBefore = [...dag.nodes];
    const edgesBefore = [...dag.edges.entries()].map(([id, deps]) => [id, [...deps]]);
    const reverseEdgesBefore = [...dag.reverseEdges.entries()].map(([id, deps]) => [id, [...deps]]);
    const pendingBefore = [...dag.pendingDeps.entries()];

    DAG.getReady(dag, new Set());

    expect([...dag.nodes]).toEqual(nodesBefore);
    expect([...dag.edges.entries()].map(([id, deps]) => [id, [...deps]])).toEqual(edgesBefore);
    expect([...dag.reverseEdges.entries()].map(([id, deps]) => [id, [...deps]])).toEqual(
      reverseEdgesBefore,
    );
    expect([...dag.pendingDeps.entries()]).toEqual(pendingBefore);
  });
});
