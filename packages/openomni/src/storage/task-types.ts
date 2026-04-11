export namespace Task {
  export type Status =
    | "idle"
    | "scheduled"
    | "running"
    | "blocked"
    | "done"
    | "failed"
    | "cancelled";

  export interface Owner {
    readonly type: "user" | "agent";
    readonly id: string;
  }

  export interface Info {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly owner: Owner;
    readonly assignedAgentId?: string;
    readonly status: Status;
    readonly tags?: string[];
  }

  export type RunStatus = Exclude<Status, "idle">;

  export interface Run {
    readonly runId: string;
    readonly taskId: string;
    readonly sessionKey: string;
    readonly status: RunStatus;
    readonly trigger: {
      readonly id: string;
      readonly type: "cron" | "interval" | "once" | "event" | "manual";
    };
    readonly idempotencyKey: string;
    readonly scheduledAt: number;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly payload?: Record<string, unknown>;
    readonly context?: {
      readonly conversationSessionId?: string;
      readonly userId?: string;
      readonly workspaceId?: string;
      readonly traceId?: string;
    };
    readonly attempt: number;
    readonly agentId?: string;
    readonly summary?: string;
    readonly error?: string;
    readonly checkpoint?: {
      readonly step: string;
      readonly data: Record<string, unknown>;
      readonly savedAt: number;
    };
    readonly spawnedBy?: {
      readonly taskId: string;
      readonly runId: string;
      readonly sessionId: string;
    };
  }
}
