import { z } from "zod";

export namespace RuntimeResource {
  const Kind = z.enum([
    "tool",
    "skill",
    "mcpSource",
    "worker",
    "credential",
    "session",
    "policy",
    "dispatch",
    "work",
  ]);

  export const Source = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("system"),
    }),
    z.object({
      type: z.literal("mcp"),
      serverId: z.string().optional(),
      remoteName: z.string().optional(),
    }),
    z.object({
      type: z.literal("skill-mcp"),
      serverId: z.string().optional(),
      remoteName: z.string().optional(),
      skillId: z.string().optional(),
    }),
    z.object({
      type: z.literal("agent"),
      agentId: z.string().optional(),
      agentProfileRef: z.string().optional(),
    }),
    z.object({
      type: z.literal("server"),
      serverId: z.string().optional(),
      remoteName: z.string().optional(),
    }),
    z.object({
      type: z.literal("project"),
      projectId: z.string().optional(),
      path: z.string().optional(),
    }),
    z.object({
      type: z.literal("user"),
      userId: z.string().optional(),
    }),
    z.object({
      type: z.literal("global"),
      scope: z.string().optional(),
    }),
    z.object({
      type: z.literal("coordinator"),
      coordinatorId: z.string().optional(),
      workerId: z.string().optional(),
    }),
    z.object({
      type: z.literal("runtime"),
      runtimeId: z.string().optional(),
    }),
    z.object({
      type: z.literal("file"),
      path: z.string().optional(),
      filePath: z.string().optional(),
    }),
  ]);
  export type Source = z.infer<typeof Source>;

  export const Descriptor = z
    .object({
      id: z.string().min(1),
      kind: Kind,
      version: z.string().optional(),
      labels: z.array(z.string()),
      capabilities: z.array(z.string()),
      effects: z.array(z.string()),
      risk: z.number().optional(),
      source: Source.optional(),
      schemaRef: z.string().optional(),
      digest: z.string().optional(),
      owner: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const segments = value.id.split(":");
      const hasValidSegments =
        segments.length === 2 ||
        segments.length === 3 ||
        (value.kind === "tool" && segments.length === 4);

      if (!hasValidSegments) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "id must use kind:name or kind:source:name format",
        });
        return;
      }

      if (segments.some((segment) => segment.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "id segments must not be empty",
        });
      }

      if (segments[0] !== value.kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "id kind segment must match kind",
        });
      }

      if (value.kind === "tool") {
        if (value.source === undefined && segments.length !== 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["id"],
            message: "descriptor source metadata requires a three-segment id",
          });
        }

        if (value.source !== undefined && segments.length !== 3 && segments.length !== 4) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["id"],
            message: "descriptor source metadata requires a three- or four-segment id",
          });
        }

        if (value.source !== undefined && segments[1] !== value.source.type) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["id"],
            message: "id source segment must match source.type",
          });
        }
      }
    });
  export type Descriptor = z.infer<typeof Descriptor>;
}
