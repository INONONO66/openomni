export type PermissionLevel = "ask" | "notify" | "deny";

export interface PermissionDecision {
  level: PermissionLevel;
  reason?: string;
}

export interface PermissionContext {
  taskPolicy?: PermissionLevel;
  agentPolicy?: PermissionLevel;
  systemDefault: PermissionLevel;
}

export namespace PermissionGate {
  export function evaluate(context: PermissionContext): PermissionDecision {
    const { taskPolicy, agentPolicy, systemDefault } = context;

    if (taskPolicy !== undefined) {
      return {
        level: taskPolicy,
        reason: "Selected from task policy",
      };
    }

    if (agentPolicy !== undefined) {
      return {
        level: agentPolicy,
        reason: "Selected from agent policy",
      };
    }

    return {
      level: systemDefault,
      reason: "Selected from system default",
    };
  }
}
