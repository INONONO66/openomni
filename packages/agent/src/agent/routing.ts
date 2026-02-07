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

export namespace RouteResolver {
  export function resolveNextNodes(
    graph: AgentGraphSpec,
    currentNodeId: string,
    context: RouteContext,
  ): string[] {
    const currentNode = graph.nodes[currentNodeId];
    if (!currentNode) {
      throw new RoutingError(`Node ${currentNodeId} not found in graph`);
    }

    const outgoingEdges = Object.values(graph.edges).filter(
      (edge) => edge.from === currentNodeId,
    );

    return outgoingEdges
      .filter((edge) => evaluateCondition(edge.condition, context))
      .map((edge) => edge.to);
  }

  export function evaluateCondition(
    condition: RouteCondition,
    context: RouteContext,
  ): boolean {
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
      case "llm_router":
        console.warn(
          "llm_router condition evaluation not yet implemented; returning false",
        );
        return false;
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
