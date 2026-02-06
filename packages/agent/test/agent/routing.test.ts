import { describe, it, expect } from "bun:test";
import { RouteResolver, RoutingError } from "../../src/agent/routing";
import type { AgentGraphSpec, RouteCondition } from "../../src/agent/graph";

const baseGraph = (edges: AgentGraphSpec["edges"]): AgentGraphSpec => ({
  version: "1",
  entryNodeId: "start",
  nodes: {
    start: { id: "start", kind: "router" },
    "node-1": { id: "node-1", kind: "agent", agentId: "agent-1" },
    "node-2": { id: "node-2", kind: "agent", agentId: "agent-2" },
  },
  edges,
});

const baseContext = (graph: AgentGraphSpec) => ({
  taskId: "task-1",
  runId: "run-1",
  taskStatus: "idle",
  lastRunStatus: "succeeded",
  summary: "ok",
  trigger: "manual",
  graph,
});

describe("RouteResolver", () => {
  it("resolveNextNodes returns empty array when no edges match", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: {
          type: "when_field",
          path: "taskStatus",
          op: "eq",
          value: "running",
        },
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual([]);
  });

  it("resolveNextNodes returns target nodes for edges with always condition", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: { type: "always" },
      },
      "edge-2": {
        id: "edge-2",
        from: "start",
        to: "node-2",
        mode: "event",
        condition: { type: "always" },
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual(["node-1", "node-2"]);
  });

  it("resolveNextNodes filters by on_status condition (single status)", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: {
          type: "on_status",
          status: "succeeded",
        } as unknown as RouteCondition,
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual(["node-1"]);
  });

  it("resolveNextNodes filters by on_status condition (array of statuses)", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: {
          type: "on_status",
          status: ["failed", "succeeded"],
        },
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual(["node-1"]);
  });

  it("resolveNextNodes filters by when_field condition with eq operator", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: {
          type: "when_field",
          path: "taskStatus",
          op: "eq",
          value: "idle",
        },
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual(["node-1"]);
  });

  it("resolveNextNodes filters by when_field condition with in operator", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: {
          type: "when_field",
          path: "trigger",
          op: "in",
          value: ["manual", "cron"],
        },
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual(["node-1"]);
  });

  it("resolveNextNodes filters by when_field condition with exists operator", () => {
    const graph = baseGraph({
      "edge-1": {
        id: "edge-1",
        from: "start",
        to: "node-1",
        mode: "event",
        condition: {
          type: "when_field",
          path: "summary",
          op: "exists",
        },
      },
    });

    const context = baseContext(graph);
    const next = RouteResolver.resolveNextNodes(graph, "start", context);

    expect(next).toEqual(["node-1"]);
  });

  it("resolveNextNodes throws RoutingError for non-existent node", () => {
    const graph = baseGraph({});
    const context = baseContext(graph);

    expect(() =>
      RouteResolver.resolveNextNodes(graph, "missing", context),
    ).toThrow(RoutingError);
  });

  it("evaluateCondition returns true for always condition", () => {
    const graph = baseGraph({});
    const context = baseContext(graph);

    expect(RouteResolver.evaluateCondition({ type: "always" }, context)).toBe(
      true,
    );
  });

  it("evaluateCondition evaluates on_status correctly", () => {
    const graph = baseGraph({});
    const context = { ...baseContext(graph), lastRunStatus: undefined };

    expect(
      RouteResolver.evaluateCondition(
        { type: "on_status", status: ["succeeded"] },
        context,
      ),
    ).toBe(false);
  });
});
