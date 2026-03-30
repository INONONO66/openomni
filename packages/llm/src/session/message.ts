import { z } from "zod";
import { APIError } from "../error";
import { Tool } from "./tool";

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
    metadata: z.record(z.string(), z.any()).optional(),
  });
  export type TextPart = z.infer<typeof TextPart>;

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
    metadata: z.record(z.string(), z.any()).optional(),
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
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
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

  export const Info = z.discriminatedUnion("role", [UserMessage, AssistantMessage]);
  export type Info = z.infer<typeof Info>;

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  });
  export type WithParts = z.infer<typeof WithParts>;
}
