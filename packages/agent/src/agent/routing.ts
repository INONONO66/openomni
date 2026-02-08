import { AgentGraphSpec, RouteCondition } from "./graph";

export interface RouteContext {
  taskId: string;
  runId: string;
  taskStatus: string;
  lastRunStatus: string | undefined;
  summary: string | undefined;
  trigger: string;
  graph: AgentGraphSpec;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Function type for LLM-based routing decisions.
 * Takes routing context and allowed edge IDs, returns the selected edge ID.
 */
export type LLMRouterFn = (
  context: RouteContext,
  allowedEdgeIds: string[],
  outputSchemaRef: string,
) => Promise<string>;

let llmRouterFn: LLMRouterFn | undefined;

/**
 * Sets the LLM router function for llm_router condition evaluation.
 * Must be called before using llm_router conditions.
 */
export function setLLMRouter(fn: LLMRouterFn): void {
  llmRouterFn = fn;
}

/**
 * Gets the current LLM router function.
 */
export function getLLMRouter(): LLMRouterFn | undefined {
  return llmRouterFn;
}

export namespace RouteResolver {
  export async function resolveNextNodes(
    graph: AgentGraphSpec,
    currentNodeId: string,
    context: RouteContext,
  ): Promise<string[]> {
    const currentNode = graph.nodes[currentNodeId];
    if (!currentNode) {
      throw new RoutingError(`Node ${currentNodeId} not found in graph`);
    }

    const outgoingEdges = Object.values(graph.edges).filter(
      (edge) => edge.from === currentNodeId,
    );

    const evaluatedEdges = await Promise.all(
      outgoingEdges.map(async (edge) => ({
        edge,
        matches: await evaluateCondition(edge.condition, context, edge.id),
      })),
    );

    return evaluatedEdges
      .filter(({ matches }) => matches)
      .map(({ edge }) => edge.to);
  }

  export async function evaluateCondition(
    condition: RouteCondition,
    context: RouteContext,
    edgeId?: string,
  ): Promise<boolean> {
    switch (condition.type) {
      case "always":
        return true;
      case "on_status": {
        const statusList = condition.status;
        if (Array.isArray(statusList)) {
          if (!context.lastRunStatus) {
            return false;
          }
          return statusList.includes(
            context.lastRunStatus as (typeof statusList)[number],
          );
        }
        return context.lastRunStatus === statusList;
      }
      case "when_field": {
        const fieldPath =
          "field" in condition && typeof condition.field === "string"
            ? condition.field
            : condition.path;
        const fieldValue = getFieldValue(context, fieldPath);

        switch (condition.op) {
          case "eq":
            return fieldValue === condition.value;
          case "in": {
            const values =
              "values" in condition
                ? condition.values
                : Array.isArray(condition.value)
                  ? condition.value
                  : undefined;
            return (
              Array.isArray(values) &&
              values.some((value) => value === fieldValue)
            );
          }
          case "exists":
            return fieldValue !== undefined;
          default:
            return false;
        }
      }
      case "llm_router": {
        if (!llmRouterFn) {
          throw new RoutingError(
            "LLM router function not configured. Call setLLMRouter() before using llm_router conditions.",
          );
        }

        if (!edgeId) {
          throw new RoutingError(
            "Edge ID is required for llm_router condition evaluation",
          );
        }

        const selectedEdgeId = await llmRouterFn(
          context,
          condition.allowedEdgeIds,
          condition.outputSchemaRef,
        );

        if (!condition.allowedEdgeIds.includes(selectedEdgeId)) {
          throw new RoutingError(
            `LLM router returned invalid edge ID: ${selectedEdgeId}. Must be one of: ${condition.allowedEdgeIds.join(", ")}`,
          );
        }

        return selectedEdgeId === edgeId;
      }
      default:
        return false;
    }
  }

  function getFieldValue(context: RouteContext, path: string): unknown {
    if (!path) {
      return undefined;
    }

    return path.split(".").reduce<unknown>((value, key) => {
      if (value && typeof value === "object" && key in value) {
        return (value as Record<string, unknown>)[key];
      }
      return undefined;
    }, context);
  }
}
