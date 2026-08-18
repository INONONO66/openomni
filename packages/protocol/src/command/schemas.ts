import { z } from "zod";
import { Actor } from "../actor/index.js";

export namespace CommandSchemas {
  export const TargetKind = z.enum([
    "worker",
    "resident",
    "external_actor",
    "schedule",
    "session",
    "surface",
    "system",
  ]);
  export type TargetKind = z.infer<typeof TargetKind>;

  export const Target = z
    .object({
      kind: TargetKind,
      id: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      parentSessionId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
      endpointId: z.string().min(1).optional(),
      connectorInstallationId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      labels: z.array(z.string()).optional(),
    })
    .strict();
  export type Target = z.infer<typeof Target>;

  // #498 A2 — the actor-kind axis is THE one Actor.Kind vocabulary; the
  // command seam no longer owns a second enum.
  export const ActorContext = z
    .object({
      kind: Actor.Kind,
      actorId: z.string().min(1),
      agentName: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
      workerRunId: z.string().min(1).optional(),
      workspaceRoot: z.string().min(1).optional(),
      labels: z.array(z.string()).optional(),
      trustTier: Actor.TrustTier.optional(),
      reason: z.string().min(1).optional(),
    })
    .strict();
  export type ActorContext = z.infer<typeof ActorContext>;
}
