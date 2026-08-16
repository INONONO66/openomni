import { z } from "zod";
import { Token } from "../token/index.js";
import { Tool } from "../tool/index.js";

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
    /** Provider reasoning signature; resent only under a same-model check (#545 T2). */
    signature: z.string().optional(),
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
      input: Token.Count,
      output: Token.Count,
      // DEFAULT-LIVE: read-side migration — parts persisted before #61
      // (2026-03) lack the reasoning/cache lanes and the part adapter
      // schema-parses every read; the producer states the lanes since then.
      reasoning: Token.Count.default(0),
      cache: z
        .object({
          read: Token.Count.default(0),
          write: Token.Count.default(0),
        })
        .default({ read: 0, write: 0 }),
    }),
  });
  export type StepFinishPart = z.infer<typeof StepFinishPart>;

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: Tool.State,
  });
  export type ToolPart = z.infer<typeof ToolPart>;

  export const Part = z.discriminatedUnion("type", [
    TextPart,
    ReasoningPart,
    StepStartPart,
    StepFinishPart,
    ToolPart,
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
      input: Token.Count,
      output: Token.Count,
      reasoning: Token.Count,
      cache: z.object({
        read: Token.Count,
        write: Token.Count,
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
