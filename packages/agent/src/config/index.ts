import type { RouterRule } from "../loop";
import type { QueueConfig } from "../trigger";
import type { Run } from "@openomni/protocol";

export interface DedupePolicy {
  windowMs: number;
  maxEntries: number;
  onDuplicate: "drop" | "coalesce" | "summarize";
}

/**
 * Configuration for the autonomous loop system
 */
export interface AutonomousLoopConfig {
  queue: QueueConfig;
  dedupe: DedupePolicy;
  router: {
    rules: RouterRule[];
    fallbackRuleId?: string;
  };
  budgets: Run.Budget;
  permissions: {
    default: "ask" | "notify" | "deny";
  };
}

/**
 * Configuration manager for the autonomous loop
 */
export namespace ConfigManager {
  function getDefaultsInternal(): AutonomousLoopConfig {
    return {
      queue: {
        maxDepth: 100,
        dropPolicy: "new",
        laneConcurrency: {},
        waitWarnMs: 5000,
        defaultConcurrency: 1,
      },
      dedupe: {
        windowMs: 10 * 60 * 1000,
        maxEntries: 10_000,
        onDuplicate: "drop",
      },
      router: {
        rules: [],
        fallbackRuleId: undefined,
      },
      budgets: {
        maxWallTimeMs: 5 * 60 * 1000,
        maxTurns: 24,
        maxToolCalls: 40,
        maxToolRuntimeMs: 2 * 60 * 1000,
      },
      permissions: {
        default: "notify",
      },
    };
  }

  function deepMerge(
    target: AutonomousLoopConfig,
    source: Partial<AutonomousLoopConfig>,
  ): AutonomousLoopConfig {
    const result = JSON.parse(JSON.stringify(target));

    if (source.queue) {
      result.queue = { ...result.queue, ...source.queue };
    }

    if (source.dedupe) {
      result.dedupe = { ...result.dedupe, ...source.dedupe };
    }

    if (source.router) {
      result.router = { ...result.router, ...source.router };
    }

    if (source.budgets) {
      result.budgets = { ...result.budgets, ...source.budgets };
    }

    if (source.permissions) {
      result.permissions = { ...result.permissions, ...source.permissions };
    }

    return result;
  }

  /**
   * Create a configuration with defaults merged with overrides
   */
  export function create(
    overrides: Partial<AutonomousLoopConfig> = {},
  ): AutonomousLoopConfig {
    const defaults = getDefaultsInternal();
    return deepMerge(defaults, overrides);
  }

  /**
   * Get the default configuration
   */
  export function getDefaults(): AutonomousLoopConfig {
    return getDefaultsInternal();
  }

  /**
   * Validate a configuration
   */
  export function validate(config: AutonomousLoopConfig): boolean {
    if (
      typeof config.queue?.maxDepth !== "number" ||
      config.queue.maxDepth <= 0
    ) {
      return false;
    }

    if (
      !["new", "old", "summarize"].includes(config.queue.dropPolicy) ||
      typeof config.queue.laneConcurrency !== "object"
    ) {
      return false;
    }

    if (
      typeof config.dedupe?.windowMs !== "number" ||
      config.dedupe.windowMs <= 0 ||
      typeof config.dedupe.maxEntries !== "number" ||
      config.dedupe.maxEntries <= 0
    ) {
      return false;
    }

    if (
      !["drop", "coalesce", "summarize"].includes(config.dedupe.onDuplicate)
    ) {
      return false;
    }

    if (!Array.isArray(config.router?.rules)) {
      return false;
    }

    if (
      typeof config.budgets?.maxWallTimeMs !== "number" ||
      typeof config.budgets?.maxTurns !== "number" ||
      typeof config.budgets?.maxToolCalls !== "number" ||
      typeof config.budgets?.maxToolRuntimeMs !== "number"
    ) {
      return false;
    }

    if (!["ask", "notify", "deny"].includes(config.permissions?.default)) {
      return false;
    }

    return true;
  }
}
