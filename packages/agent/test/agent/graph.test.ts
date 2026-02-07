import { describe, it, expect } from "bun:test";
import {
  validateEdgeReferences,
  validateNodeReachability,
  validateRouterNodes,
  validateAgentGraph,
  GraphValidationError,
  AgentGraphSpecSchema,
  RouteConditionSchema,
  AgentNodeSchema,
  type AgentGraphSpec,
  type AgentNode,
  type RouteCondition,
} from "../../src/agent/graph";

const createBaseGraph = (
  overrides: Partial<AgentGraphSpec> = {},
): AgentGraphSpec => ({
  version: "1.0.0",
  entryNodeId: "entry",
  nodes: {
    entry: { id: "entry", kind: "router" },
    "agent-1": { id: "agent-1", kind: "agent", agentId: "agent-profile-1" },
    "agent-2": { id: "agent-2", kind: "agent", agentId: "agent-profile-2" },
    sink: { id: "sink", kind: "sink" },
  },
  edges: {
    "edge-1": {
      id: "edge-1",
      from: "entry",
      to: "agent-1",
      mode: "request_response",
      condition: { type: "always" },
    },
    "edge-2": {
      id: "edge-2",
      from: "entry",
      to: "agent-2",
      mode: "event",
      condition: { type: "always" },
    },
    "edge-3": {
      id: "edge-3",
      from: "agent-1",
      to: "sink",
      mode: "broadcast",
      condition: { type: "always" },
    },
    "edge-4": {
      id: "edge-4",
      from: "agent-2",
      to: "sink",
      mode: "request_response",
      condition: { type: "always" },
    },
  },
  ...overrides,
});

describe("Graph Validation", () => {
  describe("validateEdgeReferences", () => {
    it("should pass for valid edge references", () => {
      const graph = createBaseGraph();
      expect(() => validateEdgeReferences(graph)).not.toThrow();
    });

    it("should throw for edge with non-existent source node", () => {
      const graph = createBaseGraph({
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "non-existent",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateEdgeReferences(graph)).toThrow(GraphValidationError);
      expect(() => validateEdgeReferences(graph)).toThrow(
        /references non-existent source node/,
      );
    });

    it("should throw for edge with non-existent target node", () => {
      const graph = createBaseGraph({
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "entry",
            to: "non-existent",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateEdgeReferences(graph)).toThrow(GraphValidationError);
      expect(() => validateEdgeReferences(graph)).toThrow(
        /references non-existent target node/,
      );
    });

    it("should throw for multiple invalid edges", () => {
      const graph = createBaseGraph({
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "missing-from",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
          "edge-2": {
            id: "edge-2",
            from: "entry",
            to: "missing-to",
            mode: "event",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateEdgeReferences(graph)).toThrow(GraphValidationError);
    });
  });

  describe("validateNodeReachability", () => {
    it("should pass when all nodes are reachable from entry", () => {
      const graph = createBaseGraph();
      expect(() => validateNodeReachability(graph)).not.toThrow();
    });

    it("should throw when entry node does not exist", () => {
      const graph = createBaseGraph({
        entryNodeId: "non-existent",
      });

      expect(() => validateNodeReachability(graph)).toThrow(
        GraphValidationError,
      );
      expect(() => validateNodeReachability(graph)).toThrow(/Entry node/);
    });

    it("should throw when some nodes are unreachable", () => {
      const graph = createBaseGraph({
        nodes: {
          entry: { id: "entry", kind: "router" },
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
          unreachable: { id: "unreachable", kind: "sink" },
        },
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "entry",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateNodeReachability(graph)).toThrow(
        GraphValidationError,
      );
      expect(() => validateNodeReachability(graph)).toThrow(/unreachable/);
    });

    it("should handle graphs with single node", () => {
      const graph = createBaseGraph({
        nodes: {
          entry: { id: "entry", kind: "sink" },
        },
        edges: {},
      });

      expect(() => validateNodeReachability(graph)).not.toThrow();
    });

    it("should handle graphs with cycles", () => {
      const graph = createBaseGraph({
        nodes: {
          "node-1": { id: "node-1", kind: "router" },
          "node-2": { id: "node-2", kind: "agent", agentId: "agent-1" },
          "node-3": { id: "node-3", kind: "agent", agentId: "agent-2" },
        },
        entryNodeId: "node-1",
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "node-1",
            to: "node-2",
            mode: "request_response",
            condition: { type: "always" },
          },
          "edge-2": {
            id: "edge-2",
            from: "node-2",
            to: "node-3",
            mode: "event",
            condition: { type: "always" },
          },
          "edge-3": {
            id: "edge-3",
            from: "node-3",
            to: "node-1",
            mode: "broadcast",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateNodeReachability(graph)).not.toThrow();
    });
  });

  describe("validateRouterNodes", () => {
    it("should pass when all router nodes have outgoing edges", () => {
      const graph = createBaseGraph();
      expect(() => validateRouterNodes(graph)).not.toThrow();
    });

    it("should throw when router node has no outgoing edges", () => {
      const graph = createBaseGraph({
        nodes: {
          entry: { id: "entry", kind: "router" },
          "router-2": { id: "router-2", kind: "router" },
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
        },
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "entry",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateRouterNodes(graph)).toThrow(GraphValidationError);
      expect(() => validateRouterNodes(graph)).toThrow(/no outgoing edges/);
    });

    it("should pass when non-router nodes have no outgoing edges", () => {
      const graph = createBaseGraph({
        nodes: {
          entry: { id: "entry", kind: "router" },
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
          sink: { id: "sink", kind: "sink" },
        },
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "entry",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
          "edge-2": {
            id: "edge-2",
            from: "agent-1",
            to: "sink",
            mode: "event",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateRouterNodes(graph)).not.toThrow();
    });

    it("should handle multiple router nodes with edges", () => {
      const graph = createBaseGraph({
        nodes: {
          "router-1": { id: "router-1", kind: "router" },
          "router-2": { id: "router-2", kind: "router" },
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
          "agent-2": {
            id: "agent-2",
            kind: "agent",
            agentId: "agent-profile-2",
          },
        },
        entryNodeId: "router-1",
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "router-1",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
          "edge-2": {
            id: "edge-2",
            from: "router-1",
            to: "router-2",
            mode: "event",
            condition: { type: "always" },
          },
          "edge-3": {
            id: "edge-3",
            from: "router-2",
            to: "agent-2",
            mode: "broadcast",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateRouterNodes(graph)).not.toThrow();
    });

    it("should pass when no router nodes exist", () => {
      const graph = createBaseGraph({
        nodes: {
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
          sink: { id: "sink", kind: "sink" },
        },
        entryNodeId: "agent-1",
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "agent-1",
            to: "sink",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateRouterNodes(graph)).not.toThrow();
    });
  });

  describe("validateAgentGraph", () => {
    it("should pass for valid graph", () => {
      const graph = createBaseGraph();
      expect(() => validateAgentGraph(graph)).not.toThrow();
    });

    it("should throw for invalid edge references", () => {
      const graph = createBaseGraph({
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "missing",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateAgentGraph(graph)).toThrow(GraphValidationError);
    });

    it("should throw for unreachable nodes", () => {
      const graph = createBaseGraph({
        nodes: {
          entry: { id: "entry", kind: "router" },
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
          unreachable: { id: "unreachable", kind: "sink" },
        },
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "entry",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateAgentGraph(graph)).toThrow(GraphValidationError);
    });

    it("should throw for router without outgoing edges", () => {
      const graph = createBaseGraph({
        nodes: {
          entry: { id: "entry", kind: "router" },
          "router-2": { id: "router-2", kind: "router" },
          "agent-1": {
            id: "agent-1",
            kind: "agent",
            agentId: "agent-profile-1",
          },
        },
        edges: {
          "edge-1": {
            id: "edge-1",
            from: "entry",
            to: "agent-1",
            mode: "request_response",
            condition: { type: "always" },
          },
        },
      });

      expect(() => validateAgentGraph(graph)).toThrow(GraphValidationError);
    });

    it("should validate schema before running custom validations", () => {
      const invalidGraph = {
        version: "1.0.0",
        entryNodeId: "entry",
        nodes: {
          entry: { id: "entry", kind: "invalid-kind" },
        },
        edges: {},
      } as unknown as AgentGraphSpec;

      expect(() => validateAgentGraph(invalidGraph)).toThrow();
    });
  });

  describe("AgentGraphSpecSchema.parse()", () => {
    it("should parse valid graph", () => {
      const graph = createBaseGraph();
      const parsed = AgentGraphSpecSchema.parse(graph);

      expect(parsed.version).toBe("1.0.0");
      expect(parsed.entryNodeId).toBe("entry");
      expect(Object.keys(parsed.nodes)).toContain("entry");
      expect(Object.keys(parsed.edges)).toContain("edge-1");
    });

    it("should reject graph without version", () => {
      const invalid = {
        entryNodeId: "entry",
        nodes: { entry: { id: "entry", kind: "router" } },
        edges: {},
      };

      expect(() => AgentGraphSpecSchema.parse(invalid)).toThrow();
    });

    it("should reject graph without entryNodeId", () => {
      const invalid = {
        version: "1.0.0",
        nodes: { entry: { id: "entry", kind: "router" } },
        edges: {},
      };

      expect(() => AgentGraphSpecSchema.parse(invalid)).toThrow();
    });

    it("should reject graph without nodes", () => {
      const invalid = {
        version: "1.0.0",
        entryNodeId: "entry",
        edges: {},
      };

      expect(() => AgentGraphSpecSchema.parse(invalid)).toThrow();
    });

    it("should reject graph without edges", () => {
      const invalid = {
        version: "1.0.0",
        entryNodeId: "entry",
        nodes: { entry: { id: "entry", kind: "router" } },
      };

      expect(() => AgentGraphSpecSchema.parse(invalid)).toThrow();
    });

    it("should accept optional policies", () => {
      const graph = createBaseGraph({
        policies: {
          "policy-1": {
            tools: ["calculator"],
            dataScopes: [
              {
                type: "files",
                allow: "read",
                roots: ["/data"],
              },
            ],
          },
        },
      });

      const parsed = AgentGraphSpecSchema.parse(graph);
      expect(parsed.policies).toBeDefined();
      expect(parsed.policies?.["policy-1"]).toBeDefined();
    });
  });

  describe("RouteConditionSchema with llm_router variant", () => {
    it("should parse always condition", () => {
      const condition: RouteCondition = { type: "always" };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("always");
    });

    it("should parse on_status condition with single status", () => {
      const condition: RouteCondition = {
        type: "on_status",
        status: ["succeeded"],
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("on_status");
      if (parsed.type === "on_status") {
        expect(parsed.status).toEqual(["succeeded"]);
      }
    });

    it("should parse on_status condition with multiple statuses", () => {
      const condition: RouteCondition = {
        type: "on_status",
        status: ["succeeded", "failed", "escalated"],
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("on_status");
      if (parsed.type === "on_status") {
        expect(parsed.status).toHaveLength(3);
      }
    });

    it("should parse when_field condition with eq operator", () => {
      const condition: RouteCondition = {
        type: "when_field",
        path: "taskStatus",
        op: "eq",
        value: "idle",
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("when_field");
      if (parsed.type === "when_field") {
        expect(parsed.path).toBe("taskStatus");
        expect(parsed.op).toBe("eq");
        expect(parsed.value).toBe("idle");
      }
    });

    it("should parse when_field condition with in operator", () => {
      const condition: RouteCondition = {
        type: "when_field",
        path: "trigger",
        op: "in",
        value: ["manual", "cron"],
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("when_field");
      if (parsed.type === "when_field") {
        expect(parsed.op).toBe("in");
        expect(parsed.value).toEqual(["manual", "cron"]);
      }
    });

    it("should parse when_field condition with exists operator", () => {
      const condition: RouteCondition = {
        type: "when_field",
        path: "summary",
        op: "exists",
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("when_field");
      if (parsed.type === "when_field") {
        expect(parsed.op).toBe("exists");
        expect(parsed.value).toBeUndefined();
      }
    });

    it("should parse llm_router condition", () => {
      const condition: RouteCondition = {
        type: "llm_router",
        allowedEdgeIds: ["edge-1", "edge-2", "edge-3"],
        outputSchemaRef: "schema-ref-123",
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("llm_router");
      if (parsed.type === "llm_router") {
        expect(parsed.allowedEdgeIds).toEqual(["edge-1", "edge-2", "edge-3"]);
        expect(parsed.outputSchemaRef).toBe("schema-ref-123");
      }
    });

    it("should parse llm_router with empty allowedEdgeIds", () => {
      const condition: RouteCondition = {
        type: "llm_router",
        allowedEdgeIds: [],
        outputSchemaRef: "schema-ref",
      };
      const parsed = RouteConditionSchema.parse(condition);

      expect(parsed.type).toBe("llm_router");
      if (parsed.type === "llm_router") {
        expect(parsed.allowedEdgeIds).toEqual([]);
      }
    });

    it("should reject invalid condition type", () => {
      const invalid = {
        type: "invalid-type",
      };

      expect(() => RouteConditionSchema.parse(invalid)).toThrow();
    });

    it("should reject on_status without status array", () => {
      const invalid = {
        type: "on_status",
      };

      expect(() => RouteConditionSchema.parse(invalid)).toThrow();
    });

    it("should reject when_field without required fields", () => {
      const invalid = {
        type: "when_field",
        path: "taskStatus",
      };

      expect(() => RouteConditionSchema.parse(invalid)).toThrow();
    });

    it("should reject llm_router without allowedEdgeIds", () => {
      const invalid = {
        type: "llm_router",
        outputSchemaRef: "schema-ref",
      };

      expect(() => RouteConditionSchema.parse(invalid)).toThrow();
    });

    it("should reject llm_router without outputSchemaRef", () => {
      const invalid = {
        type: "llm_router",
        allowedEdgeIds: ["edge-1"],
      };

      expect(() => RouteConditionSchema.parse(invalid)).toThrow();
    });
  });

  describe("AgentNodeSchema with agentId refinement", () => {
    it("should accept agent node with agentId", () => {
      const node: AgentNode = {
        id: "agent-1",
        kind: "agent",
        agentId: "agent-profile-1",
      };
      const parsed = AgentNodeSchema.parse(node);

      expect(parsed.id).toBe("agent-1");
      expect(parsed.kind).toBe("agent");
      expect(parsed.agentId).toBe("agent-profile-1");
    });

    it("should reject agent node without agentId", () => {
      const invalid = {
        id: "agent-1",
        kind: "agent",
      };

      expect(() => AgentNodeSchema.parse(invalid)).toThrow();
      expect(() => AgentNodeSchema.parse(invalid)).toThrow(
        /agentId is required/,
      );
    });

    it("should accept router node without agentId", () => {
      const node: AgentNode = {
        id: "router-1",
        kind: "router",
      };
      const parsed = AgentNodeSchema.parse(node);

      expect(parsed.id).toBe("router-1");
      expect(parsed.kind).toBe("router");
      expect(parsed.agentId).toBeUndefined();
    });

    it("should accept supervisor node without agentId", () => {
      const node: AgentNode = {
        id: "supervisor-1",
        kind: "supervisor",
      };
      const parsed = AgentNodeSchema.parse(node);

      expect(parsed.kind).toBe("supervisor");
      expect(parsed.agentId).toBeUndefined();
    });

    it("should accept tool-gateway node without agentId", () => {
      const node: AgentNode = {
        id: "gateway-1",
        kind: "tool-gateway",
      };
      const parsed = AgentNodeSchema.parse(node);

      expect(parsed.kind).toBe("tool-gateway");
      expect(parsed.agentId).toBeUndefined();
    });

    it("should accept sink node without agentId", () => {
      const node: AgentNode = {
        id: "sink-1",
        kind: "sink",
      };
      const parsed = AgentNodeSchema.parse(node);

      expect(parsed.kind).toBe("sink");
      expect(parsed.agentId).toBeUndefined();
    });

    it("should accept agent node with optional fields", () => {
      const node: AgentNode = {
        id: "agent-1",
        kind: "agent",
        agentId: "agent-profile-1",
        inputSchemaRef: "input-schema",
        outputSchemaRef: "output-schema",
        policyId: "policy-1",
      };
      const parsed = AgentNodeSchema.parse(node);

      expect(parsed.inputSchemaRef).toBe("input-schema");
      expect(parsed.outputSchemaRef).toBe("output-schema");
      expect(parsed.policyId).toBe("policy-1");
    });

    it("should reject node without id", () => {
      const invalid = {
        kind: "agent",
        agentId: "agent-profile-1",
      };

      expect(() => AgentNodeSchema.parse(invalid)).toThrow();
    });

    it("should reject node without kind", () => {
      const invalid = {
        id: "agent-1",
        agentId: "agent-profile-1",
      };

      expect(() => AgentNodeSchema.parse(invalid)).toThrow();
    });

    it("should reject node with invalid kind", () => {
      const invalid = {
        id: "agent-1",
        kind: "invalid-kind",
        agentId: "agent-profile-1",
      };

      expect(() => AgentNodeSchema.parse(invalid)).toThrow();
    });
  });
});
