import { z } from "zod";
import { policyKernelVersion } from "./version.js";

export namespace RuntimeResource {
  export const schemaVersion = policyKernelVersion;

  export const Kind = z.enum([
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
  export type Kind = z.infer<typeof Kind>;

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

  export const ActorType = z.enum(["user", "agent", "system"]);
  export type ActorType = z.infer<typeof ActorType>;

  export const SessionType = z.enum(["root", "child", "self-loop"]);
  export type SessionType = z.infer<typeof SessionType>;

  export const ActorDescriptor = z.object({
    actorId: z.string().min(1),
    actorType: ActorType,
    agentProfileRef: z.string().optional(),
    permissions: z.array(z.string()),
    labels: z.array(z.string()).optional(),
    digest: z.string().optional(),
  });
  export type ActorDescriptor = z.infer<typeof ActorDescriptor>;

  export const SessionDescriptor = z.object({
    sessionId: z.string().min(1),
    parentSessionId: z.string().optional(),
    sessionType: SessionType,
    ownerActorId: z.string().min(1),
    digest: z.string().optional(),
  });
  export type SessionDescriptor = z.infer<typeof SessionDescriptor>;

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

  type DescriptorInput = {
    id: string;
    kind: Kind;
    labels?: string[];
    capabilities?: string[];
    effects?: string[];
    source?: Source;
    schemaRef?: string;
    digest?: string;
    owner?: string;
    version?: string;
    risk?: number;
  };

  function createDescriptor(input: DescriptorInput): Descriptor {
    return Descriptor.parse({
      labels: [],
      capabilities: [],
      effects: [],
      ...input,
    });
  }

  export function createWorkerDescriptor(workerId: string, opts?: { source?: string }): Descriptor {
    return createDescriptor({
      id: `worker:coordinator:${workerId}`,
      kind: "worker",
      labels: ["source.coordinator", "worker.coordinator"],
      source:
        opts?.source === undefined
          ? { type: "coordinator" }
          : { type: "coordinator", coordinatorId: opts.source },
    });
  }

  export function createCredentialDescriptor(
    provider: string,
    credType: string,
    opts?: { source?: string },
  ): Descriptor {
    return createDescriptor({
      id: `credential:${provider}:${credType}`,
      kind: "credential",
      labels: ["source.file", `credential.${provider}`],
      source: opts?.source === undefined ? { type: "file" } : { type: "file", path: opts.source },
    });
  }

  export function createSessionDescriptor(
    sessionId: string,
    sessionType: string,
    opts?: { parentSessionId?: string; ownerActorId?: string },
  ): Descriptor {
    const normalizedSessionType = SessionType.parse(sessionType);
    const labels = ["source.runtime", `session.${normalizedSessionType}`];

    if (opts?.parentSessionId !== undefined) {
      labels.push(`session.parent:${opts.parentSessionId}`);
    }

    return createDescriptor({
      id: `session:${sessionId}`,
      kind: "session",
      labels,
      source: { type: "runtime", runtimeId: sessionId },
      ...(opts?.ownerActorId === undefined ? {} : { owner: opts.ownerActorId }),
    });
  }
}
