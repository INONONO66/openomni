import { z } from "zod";

// ============================================================
// Error Classes (Base)
// ============================================================

export abstract class NamedError extends Error {
  abstract schema(): z.ZodType;
  abstract toObject(): { name: string; data: unknown };

  static create<Name extends string, Data extends z.ZodType>(
    name: Name,
    data: Data,
  ) {
    const schema = z.object({
      name: z.literal(name),
      data,
    });
    const result = class extends NamedError {
      public static readonly Schema = schema;

      public override readonly name = name as Name;

      constructor(
        public readonly data: z.input<Data>,
        options?: { cause?: unknown },
      ) {
        const message =
          typeof data === "object" &&
          data !== null &&
          "message" in data &&
          typeof data.message === "string"
            ? data.message
            : name;
        super(message);
        if (options?.cause) {
          (this as any).cause = options.cause;
        }
        this.name = name;
      }

      static isInstance(input: unknown): input is InstanceType<typeof result> {
        return (
          typeof input === "object" &&
          input !== null &&
          "name" in input &&
          input.name === name
        );
      }

      schema() {
        return schema;
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        };
      }
    };
    Object.defineProperty(result, "name", { value: name });
    return result;
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
    }),
  );
}

export const APIError = NamedError.create(
  "APIError",
  z.object({
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
);

// ============================================================
// Tool Types
// ============================================================

export namespace Tool {
  export const StatePending = z.object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.unknown()),
  });
  export type StatePending = z.infer<typeof StatePending>;

  export const StateRunning = z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.unknown()),
    time: z.object({
      start: z.number(),
    }),
  });
  export type StateRunning = z.infer<typeof StateRunning>;

  export const StateCompleted = z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.unknown()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });
  export type StateCompleted = z.infer<typeof StateCompleted>;

  export const StateError = z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    error: z.string(),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });
  export type StateError = z.infer<typeof StateError>;

  export const State = z.discriminatedUnion("status", [
    StatePending,
    StateRunning,
    StateCompleted,
    StateError,
  ]);
  export type State = z.infer<typeof State>;
}

// ============================================================
// Message Types
// ============================================================

export namespace Message {
  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  });

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type TextPart = z.infer<typeof TextPart>;

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type ReasoningPart = z.infer<typeof ReasoningPart>;

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
  });
  export type StepStartPart = z.infer<typeof StepStartPart>;

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
    }),
  });
  export type StepFinishPart = z.infer<typeof StepFinishPart>;

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  });
  export type RetryPart = z.infer<typeof RetryPart>;

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: Tool.State,
  });
  export type ToolPart = z.infer<typeof ToolPart>;

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  });
  export type SnapshotPart = z.infer<typeof SnapshotPart>;

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
  });
  export type CompactionPart = z.infer<typeof CompactionPart>;

  export const Part = z.discriminatedUnion("type", [
    TextPart,
    ReasoningPart,
    StepStartPart,
    StepFinishPart,
    RetryPart,
    ToolPart,
    SnapshotPart,
    CompactionPart,
  ]);
  export type Part = z.infer<typeof Part>;

  const MessageBase = z.object({
    id: z.string(),
    sessionID: z.string(),
  });

  export const UserMessage = MessageBase.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
  });
  export type UserMessage = z.infer<typeof UserMessage>;

  export const AssistantMessage = MessageBase.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    finish: z.string().optional(),
  });
  export type AssistantMessage = z.infer<typeof AssistantMessage>;

  export const Info = z.discriminatedUnion("role", [
    UserMessage,
    AssistantMessage,
  ]);
  export type Info = z.infer<typeof Info>;

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  });
  export type WithParts = z.infer<typeof WithParts>;
}

// ============================================================
// Tool Call and Result Types
// ============================================================

export const ToolCall = z.object({
  id: z.string(),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  id: z.string(),
  toolCallId: z.string(),
  output: z.string(),
  isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const ToolSpec = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolSpec = z.infer<typeof ToolSpec>;

// ============================================================
// Run Types
// ============================================================

export const RunSnapshot = z.object({
  id: z.string(),
  sessionID: z.string(),
  timestamp: z.number(),
  state: z.record(z.string(), z.unknown()),
});
export type RunSnapshot = z.infer<typeof RunSnapshot>;

export const RunOutcome = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop") }),
  z.object({
    type: z.literal("await_tool"),
    toolCalls: z.array(ToolCall),
  }),
  z.object({ type: z.literal("aborted") }),
  z.object({
    type: z.literal("error"),
    error: z.instanceof(Error),
  }),
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

// ============================================================
// Sink Interface (TypeScript only, not Zod)
// ============================================================

export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onSnapshot: (snapshot: RunSnapshot) => void;
}

// ============================================================
// Summary and Permission Types
// ============================================================

export const Summary = z.object({
  id: z.string(),
  sessionID: z.string(),
  title: z.string(),
  content: z.string(),
  createdAt: z.number(),
});
export type Summary = z.infer<typeof Summary>;

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionPolicy = "ask" | "notify" | "deny";

// ============================================================
// Retry and Budget Types
// ============================================================

export const RetryPolicy = z.object({
  maxAttempts: z.number(),
  backoffMs: z.object({
    initial: z.number(),
    multiplier: z.number(),
    max: z.number(),
  }),
  retryOn: z
    .array(
      z.enum(["timeout", "tool_error", "transient_error", "validation_error"]),
    )
    .optional(),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const RunBudget = z.object({
  maxWallTimeMs: z.number(),
  maxTurns: z.number(),
  maxToolCalls: z.number(),
  maxToolRuntimeMs: z.number(),
});
export type RunBudget = z.infer<typeof RunBudget>;

// ============================================================
// Session Key Type
// ============================================================

export type SessionKey =
  | `agent:${string}:main`
  | `agent:${string}:subagent:${string}`
  | `task:${string}:run:${string}`;

// ============================================================
// Notification Types
// ============================================================

export {
  NotificationSeverity,
  DeliveryMode,
  NotificationRequest,
  NotificationResult,
} from "./notification";

// ============================================================
// Event Types
// ============================================================

export { BusEvent } from "./bus";
export { Task, Agent } from "./events";
