import type { RouterRule } from "./loop";

/**
 * Configuration for the autonomous loop system
 */
export interface AutonomousLoopConfig {
  triggers: {
    scheduler: {
      enabled: boolean;
    };
    watcher: {
      enabled: boolean;
    };
  };
  router: {
    rules: RouterRule[];
  };
  gates: {
    permission: {
      enabled: boolean;
      config: Record<string, unknown>;
    };
    concurrency: {
      enabled: boolean;
      config: Record<string, unknown>;
    };
    run: {
      enabled: boolean;
      config: Record<string, unknown>;
    };
  };
  recovery: {
    enabled: boolean;
    autoStart: boolean;
  };
  audit: {
    enabled: boolean;
    retentionMs: number;
  };
}

/**
 * Configuration manager for the autonomous loop
 */
export namespace ConfigManager {
  const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  function getDefaultsInternal(): AutonomousLoopConfig {
    return {
      triggers: {
        scheduler: {
          enabled: true,
        },
        watcher: {
          enabled: true,
        },
      },
      router: {
        rules: [],
      },
      gates: {
        permission: {
          enabled: true,
          config: {},
        },
        concurrency: {
          enabled: true,
          config: {
            maxConcurrent: 10,
          },
        },
        run: {
          enabled: true,
          config: {
            maxRunsPerTask: 5,
          },
        },
      },
      recovery: {
        enabled: true,
        autoStart: true,
      },
      audit: {
        enabled: true,
        retentionMs: DEFAULT_RETENTION_MS,
      },
    };
  }

  function deepMerge(
    target: AutonomousLoopConfig,
    source: Partial<AutonomousLoopConfig>,
  ): AutonomousLoopConfig {
    const result = JSON.parse(JSON.stringify(target));

    if (source.triggers) {
      result.triggers = { ...result.triggers, ...source.triggers };
    }
    if (source.router) {
      result.router = { ...result.router, ...source.router };
    }
    if (source.gates) {
      result.gates = {
        permission: {
          ...result.gates.permission,
          ...(source.gates.permission || {}),
        },
        concurrency: {
          ...result.gates.concurrency,
          ...(source.gates.concurrency || {}),
        },
        run: {
          ...result.gates.run,
          ...(source.gates.run || {}),
        },
      };
    }
    if (source.recovery) {
      result.recovery = { ...result.recovery, ...source.recovery };
    }
    if (source.audit) {
      result.audit = { ...result.audit, ...source.audit };
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
      typeof config.triggers?.scheduler?.enabled !== "boolean" ||
      typeof config.triggers?.watcher?.enabled !== "boolean"
    ) {
      return false;
    }

    if (!Array.isArray(config.router?.rules)) {
      return false;
    }

    if (
      typeof config.gates?.permission?.enabled !== "boolean" ||
      typeof config.gates?.concurrency?.enabled !== "boolean" ||
      typeof config.gates?.run?.enabled !== "boolean"
    ) {
      return false;
    }

    if (
      typeof config.gates?.permission?.config !== "object" ||
      typeof config.gates?.concurrency?.config !== "object" ||
      typeof config.gates?.run?.config !== "object"
    ) {
      return false;
    }

    if (
      typeof config.recovery?.enabled !== "boolean" ||
      typeof config.recovery?.autoStart !== "boolean"
    ) {
      return false;
    }

    if (
      typeof config.audit?.enabled !== "boolean" ||
      typeof config.audit?.retentionMs !== "number" ||
      config.audit.retentionMs < 0
    ) {
      return false;
    }

    return true;
  }
}
