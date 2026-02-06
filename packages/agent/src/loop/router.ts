import type { EventEnvelope } from "./envelope";

/**
 * Rule for routing events to tasks
 */
export interface RouterRule {
  eventName: string;
  taskId: string;
  priority: number;
}

/**
 * Router namespace for managing event-to-task routing
 */
export namespace Router {
  const rules: RouterRule[] = [];

  /**
   * Register a routing rule
   */
  export function register(rule: RouterRule): void {
    rules.push(rule);
  }

  /**
   * Unregister a specific routing rule
   */
  export function unregister(eventName: string, taskId: string): void {
    const index = rules.findIndex(
      (r) => r.eventName === eventName && r.taskId === taskId,
    );
    if (index !== -1) {
      rules.splice(index, 1);
    }
  }

  /**
   * Route an event to matching tasks, sorted by priority
   * Lower priority number = higher precedence
   */
  export function route(envelope: EventEnvelope): string[] {
    const matchingRules = rules
      .filter((r) => r.eventName === envelope.name)
      .sort((a, b) => a.priority - b.priority);

    return matchingRules.map((r) => r.taskId);
  }

  /**
   * Clear all routing rules
   */
  export function clear(): void {
    rules.length = 0;
  }
}
