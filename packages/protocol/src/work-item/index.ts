import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

export namespace WorkItem {
  export const Status = z.enum([
    "pending",
    "running",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ]);
  export type Status = z.infer<typeof Status>;

  export const Blocker = z.object({
    id: z.string(),
    description: z.string(),
    kind: z.enum(["dependency", "error", "waiting_input", "external", "unknown"]),
    createdAt: z.number(),
    resolvedAt: z.number().optional(),
  });
  export type Blocker = z.infer<typeof Blocker>;

  export const Evidence = z.object({
    id: z.string(),
    kind: z.enum(["test_result", "build_result", "review", "verification", "manual", "custom"]),
    description: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
    createdAt: z.number(),
  });
  export type Evidence = z.infer<typeof Evidence>;

  export const ExecutorKind = z.enum([
    "internal_chat_agent",
    "local_cli_agent",
    "external_api",
    "a2a",
    "human_channel",
  ]);
  export type ExecutorKind = z.infer<typeof ExecutorKind>;

  export const Outcome = z.enum(["adopted", "corrected", "redone", "ignored"]);
  export type Outcome = z.infer<typeof Outcome>;

  export const CompletionReport = z.object({
    summary: z.string().min(1),
    claims: z
      .array(
        z.object({
          statement: z.string().min(1),
          evidenceIds: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    caveats: z.array(z.string().min(1)).default([]),
    followUps: z.array(z.string().min(1)).default([]),
  });
  export type CompletionReport = z.infer<typeof CompletionReport>;

  export const VerificationGate = z.object({
    automated: z
      .object({
        passed: z.boolean(),
        checks: z.array(
          z.object({
            name: z.string(),
            passed: z.boolean(),
            output: z.string().optional(),
          }),
        ),
      })
      .optional(),
    acceptance: z
      .object({
        passed: z.boolean(),
        criteria: z.array(
          z.object({
            criterion: z.string(),
            met: z.boolean(),
            evidence: z.string().optional(),
          }),
        ),
      })
      .optional(),
    review: z
      .object({
        passed: z.boolean(),
        reviewer: z.string(),
        recommendation: z.enum(["approve", "request_changes", "reject"]),
        comments: z.string().optional(),
      })
      .optional(),
  });
  export type VerificationGate = z.infer<typeof VerificationGate>;

  export const Info = z.object({
    hash: z.string(),
    name: z.string(),
    sourceMessageId: z.string(),
    sourceChannel: z.string(),
    assigneeId: z.string().optional(),
    sessionId: z.string().optional(),
    originSessionId: z.string().min(1).optional(),
    workSessionId: z.string().min(1).optional(),
    workerRunId: z.string().min(1).optional(),
    executorKind: ExecutorKind.optional(),
    attempt: z.number().int().min(1).default(1),
    maxAttempts: z.number().int().min(1).optional(),
    timestamps: z.object({
      created: z.number(),
      updated: z.number(),
      started: z.number().optional(),
      completed: z.number().optional(),
      failed: z.number().optional(),
      cancelled: z.number().optional(),
      deadline: z.number().optional(),
    }),
    relations: z.object({
      parentHash: z.string().optional(),
      childHashes: z.array(z.string()).default([]),
      dependsOn: z.array(z.string()).default([]),
    }),
    intent: z.string(),
    goal: z.string(),
    context: z.string().optional(),
    constraints: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    changedFiles: z.array(z.string()).default([]),
    failureReason: z.string().optional(),
    blockers: z.array(Blocker).default([]),
    evidence: z.array(Evidence).default([]),
    completionReport: CompletionReport.optional(),
    verificationGate: VerificationGate.optional(),
    outcome: Outcome.optional(),
  });
  export type Info = z.infer<typeof Info>;

  export function deriveStatus(item: Info): Status {
    if (item.timestamps.cancelled !== undefined) return "cancelled";
    if (item.timestamps.failed !== undefined) return "failed";
    if (item.timestamps.completed !== undefined) return "completed";
    if (item.blockers.some((blocker) => blocker.resolvedAt === undefined)) return "blocked";
    if (item.timestamps.started !== undefined) return "running";
    return "pending";
  }

  export function generateHash(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    // constrain to exactly 36^12 range to guarantee 12-char base36 output
    const BASE12 = 4738381338321616896n; // 36n ** 12n
    n = n % BASE12;
    return `wi_${n.toString(36).padStart(12, "0")}`;
  }

  export namespace Events {
    export const Created = BusEvent.define(
      "work_item.created",
      BaseEvent.extend({
        payload: z.object({
          hash: z.string(),
          name: z.string(),
          sessionId: z.string().optional(),
          assigneeId: z.string().optional(),
        }),
      }),
    );

    export const Updated = BusEvent.define(
      "work_item.updated",
      BaseEvent.extend({
        payload: z.object({
          hash: z.string(),
          fields: z.array(z.string()),
        }),
      }),
    );

    export const StatusChanged = BusEvent.define(
      "work_item.status_changed",
      BaseEvent.extend({
        payload: z.object({
          hash: z.string(),
          from: Status,
          to: Status,
        }),
      }),
    );

    export const Completed = BusEvent.define(
      "work_item.completed",
      BaseEvent.extend({
        payload: z.object({
          hash: z.string(),
          sessionId: z.string().optional(),
        }),
      }),
    );

    export const Failed = BusEvent.define(
      "work_item.failed",
      BaseEvent.extend({
        payload: z.object({
          hash: z.string(),
          reason: z.string().optional(),
          sessionId: z.string().optional(),
        }),
      }),
    );

    export const Removed = BusEvent.define(
      "work_item.removed",
      BaseEvent.extend({
        payload: z.object({
          hash: z.string(),
          sessionId: z.string().optional(),
        }),
      }),
    );
  }
}
