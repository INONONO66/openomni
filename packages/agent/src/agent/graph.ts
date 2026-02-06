import { z } from "zod";
import { PolicySpecSchema } from "./profile";

export const NodeKindSchema = z.enum([
  "agent",
  "router",
  "supervisor",
  "tool-gateway",
  "sink",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const DeliveryModeSchema = z.enum([
  "request_response",
  "event",
  "broadcast",
]);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const RouteConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("always"),
  }),
  z.object({
    type: z.literal("on_status"),
    status: z.array(z.enum(["succeeded", "failed", "escalated"])),
  }),
  z.object({
    type: z.literal("when_field"),
    path: z.string(),
    op: z.enum(["eq", "in", "exists"]),
    value: z.unknown().optional(),
  }),
]);
export type RouteCondition = z.infer<typeof RouteConditionSchema>;

export const AgentNodeSchema = z
  .object({
    id: z.string().describe("Unique identifier for the node"),
    kind: NodeKindSchema.describe("Type of node in the graph"),
    agentId: z
      .string()
      .optional()
      .describe("Agent profile ID (required when kind === 'agent')"),
    inputSchemaRef: z.string().optional().describe("Reference to input schema"),
    outputSchemaRef: z
      .string()
      .optional()
      .describe("Reference to output schema"),
    policyId: z.string().optional().describe("Policy to apply to this node"),
  })
  .refine(
    (data) => {
      if (data.kind === "agent") {
        return data.agentId !== undefined;
      }
      return true;
    },
    {
      message: "agentId is required when kind is 'agent'",
      path: ["agentId"],
    },
  );
export type AgentNode = z.infer<typeof AgentNodeSchema>;

export const AgentEdgeSchema = z.object({
  id: z.string().describe("Unique identifier for the edge"),
  from: z.string().describe("Source node ID"),
  to: z.string().describe("Target node ID"),
  mode: DeliveryModeSchema.describe("How data is delivered"),
  condition: RouteConditionSchema.describe("Condition for routing"),
  tightenPolicyId: z
    .string()
    .optional()
    .describe("Policy to tighten on this edge"),
});
export type AgentEdge = z.infer<typeof AgentEdgeSchema>;

export const AgentGraphSpecSchema = z.object({
  version: z.string().describe("Version of the graph specification"),
  entryNodeId: z.string().describe("ID of the entry node"),
  nodes: z
    .record(z.string(), AgentNodeSchema)
    .describe("Map of node ID to node"),
  edges: z
    .record(z.string(), AgentEdgeSchema)
    .describe("Map of edge ID to edge"),
  policies: z
    .record(z.string(), PolicySpecSchema)
    .optional()
    .describe("Map of policy ID to policy spec"),
});
export type AgentGraphSpec = z.infer<typeof AgentGraphSpecSchema>;

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export function validateEdgeReferences(graph: AgentGraphSpec): void {
  const nodeIds = new Set(Object.keys(graph.nodes));

  for (const [edgeId, edge] of Object.entries(graph.edges)) {
    if (!nodeIds.has(edge.from)) {
      throw new GraphValidationError(
        `Edge ${edgeId} references non-existent source node: ${edge.from}`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new GraphValidationError(
        `Edge ${edgeId} references non-existent target node: ${edge.to}`,
      );
    }
  }
}

export function validateNodeReachability(graph: AgentGraphSpec): void {
  const nodeIds = new Set(Object.keys(graph.nodes));

  if (!nodeIds.has(graph.entryNodeId)) {
    throw new GraphValidationError(
      `Entry node ${graph.entryNodeId} does not exist in graph`,
    );
  }

  const adjacency = new Map<string, Set<string>>();
  Array.from(nodeIds).forEach((nodeId) => {
    adjacency.set(nodeId, new Set());
  });
  for (const edge of Object.values(graph.edges)) {
    adjacency.get(edge.from)?.add(edge.to);
  }

  const reachable = new Set<string>();
  const queue = [graph.entryNodeId];
  reachable.add(graph.entryNodeId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacency.get(current) || new Set();

    Array.from(neighbors).forEach((neighbor) => {
      if (!reachable.has(neighbor)) {
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    });
  }

  const unreachable = Array.from(nodeIds).filter((id) => !reachable.has(id));
  if (unreachable.length > 0) {
    throw new GraphValidationError(
      `Nodes unreachable from entry node: ${unreachable.join(", ")}`,
    );
  }
}

export function validateRouterNodes(graph: AgentGraphSpec): void {
  const routerNodes = Object.entries(graph.nodes)
    .filter(([_, node]) => node.kind === "router")
    .map(([id, _]) => id);

  const outgoingEdges = new Map<string, number>();
  for (const nodeId of routerNodes) {
    outgoingEdges.set(nodeId, 0);
  }

  for (const edge of Object.values(graph.edges)) {
    if (outgoingEdges.has(edge.from)) {
      outgoingEdges.set(edge.from, outgoingEdges.get(edge.from)! + 1);
    }
  }

  Array.from(outgoingEdges.entries()).forEach(([nodeId, count]) => {
    if (count === 0) {
      throw new GraphValidationError(
        `Router node ${nodeId} has no outgoing edges`,
      );
    }
  });
}

export function validateAgentGraph(graph: AgentGraphSpec): void {
  AgentGraphSpecSchema.parse(graph);
  validateEdgeReferences(graph);
  validateNodeReachability(graph);
  validateRouterNodes(graph);
}
