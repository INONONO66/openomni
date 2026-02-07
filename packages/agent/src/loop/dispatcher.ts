import { Task, TriggerSignal } from "../task/types";
import { TaskManager, TriggerResult } from "../task/manager";

/**
 * Resolves a nested value from an object using dot-notation path.
 * e.g. getByPath({ a: { b: 1 } }, "a.b") => 1
 */
function getByPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Check if a path exists in the object (even if value is null/undefined)
 */
function pathExists(obj: unknown, path: string): boolean {
  const segments = path.split(".");
  let current: unknown = obj;
  for (let i = 0; i < segments.length; i++) {
    if (current === null || current === undefined) return false;
    if (typeof current !== "object") return false;
    const seg = segments[i];
    if (!(seg in (current as Record<string, unknown>))) return false;
    current = (current as Record<string, unknown>)[seg];
  }
  return true;
}

/**
 * Dispatcher namespace - evaluates trigger filters and dispatches to TaskManager
 * Implements spec section 3.2.4: Trigger Filter Evaluation
 */
export namespace Dispatcher {
  /**
   * Evaluate a single filter condition against a payload
   * Supports all 10 operators: eq, neq, in, nin, exists, regex, gt, gte, lt, lte
   */
  export function evaluateCondition(
    condition: Task.TriggerFilterCondition,
    payload: unknown,
  ): boolean {
    const { path, op, value } = condition;

    if (op === "exists") {
      const exists = pathExists(payload, path);
      const expectedExists = value !== false;
      return exists === expectedExists;
    }

    const actualValue = getByPath(payload, path);

    switch (op) {
      case "eq":
        return actualValue === value;

      case "neq":
        return actualValue !== value;

      case "in": {
        if (!Array.isArray(value)) return false;
        return value.includes(actualValue);
      }

      case "nin": {
        if (!Array.isArray(value)) return true;
        return !value.includes(actualValue);
      }

      case "regex": {
        if (typeof actualValue !== "string" || typeof value !== "string") {
          return false;
        }
        try {
          return new RegExp(value).test(actualValue);
        } catch {
          return false;
        }
      }

      case "gt":
        return (
          typeof actualValue === "number" &&
          typeof value === "number" &&
          actualValue > value
        );

      case "gte":
        return (
          typeof actualValue === "number" &&
          typeof value === "number" &&
          actualValue >= value
        );

      case "lt":
        return (
          typeof actualValue === "number" &&
          typeof value === "number" &&
          actualValue < value
        );

      case "lte":
        return (
          typeof actualValue === "number" &&
          typeof value === "number" &&
          actualValue <= value
        );

      default:
        return false;
    }
  }

  /**
   * Evaluate all conditions in a filter based on mode
   * mode: 'all' requires all conditions to pass (AND logic)
   * mode: 'any' requires at least one condition to pass (OR logic)
   */
  export function evaluateFilter(
    filter: Task.TriggerFilter,
    payload: unknown,
  ): boolean {
    const { conditions, mode } = filter;

    if (conditions.length === 0) return true;

    if (mode === "any") {
      return conditions.some((cond) => evaluateCondition(cond, payload));
    }

    return conditions.every((cond) => evaluateCondition(cond, payload));
  }

  /**
   * Dispatch a trigger signal to a task
   * Pipeline: evaluate filter -> delegate to TaskManager.trigger (handles rate limit, dedupe, concurrency)
   */
  export async function dispatch(
    taskId: string,
    signal: TriggerSignal,
  ): Promise<TriggerResult> {
    const task = TaskManager.get(taskId);

    if (!task) {
      return { error: "not_found" };
    }

    const trigger = task.triggers.find((t) => t.id === signal.triggerId);

    if (!trigger) {
      return { error: "not_found" };
    }

    if (trigger.type === "event" && trigger.filter) {
      const filterPassed = evaluateFilter(trigger.filter, signal.payload ?? {});
      if (!filterPassed) {
        return { error: "filtered" };
      }
    }

    return TaskManager.trigger(taskId, signal);
  }
}
