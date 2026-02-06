export type PermissionLevel = "ask" | "notify" | "deny";

export interface PermissionDecision {
  level: PermissionLevel;
  reason?: string;
}

export interface PermissionContext {
  taskPolicy: PermissionLevel;
  agentPolicy: PermissionLevel;
  systemDefault: PermissionLevel;
}

export namespace PermissionGate {
  export function evaluate(context: PermissionContext): PermissionDecision {
    const { taskPolicy, agentPolicy, systemDefault } = context;

    const restrictiveness: Record<PermissionLevel, number> = {
      deny: 3,
      ask: 2,
      notify: 1,
    };

    const policies: Array<{ level: PermissionLevel; source: string }> = [
      { level: taskPolicy, source: "task policy" },
      { level: agentPolicy, source: "agent policy" },
      { level: systemDefault, source: "system default" },
    ];

    let mostRestrictive = policies[0];
    for (const policy of policies) {
      if (
        restrictiveness[policy.level] > restrictiveness[mostRestrictive.level]
      ) {
        mostRestrictive = policy;
      }
    }

    const decision: PermissionDecision = {
      level: mostRestrictive.level,
    };

    if (mostRestrictive.source !== "system default") {
      decision.reason = `Restricted by ${mostRestrictive.source}`;
    }

    return decision;
  }
}
