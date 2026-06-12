import { z } from "zod";

export namespace Actor {
  export const Kind = z.enum([
    "human",
    "ai_agent",
    "service",
    "resident",
    "internal_worker",
    "system",
  ]);
  export type Kind = z.infer<typeof Kind>;

  export const TrustTier = z.enum([
    "owner",
    "co_owner",
    "manager",
    "collaborator",
    "observer",
    "assigned_worker",
  ]);
  export type TrustTier = z.infer<typeof TrustTier>;

  export const Relationship = z.enum([
    "owner",
    "co_owner",
    "collaborator",
    "observer",
    "contractor",
    "external_agent",
    "worker",
  ]);
  export type Relationship = z.infer<typeof Relationship>;

  const Metadata = z.record(z.unknown());

  export const Identity = z.object({
    id: z.string().min(1),
    kind: Kind,
    trustTier: TrustTier,
    relationship: Relationship,
    displayName: z.string().min(1).optional(),
    metadata: Metadata.optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  });
  export type Identity = z.infer<typeof Identity>;

  export const Endpoint = z.object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    channel: z.string().min(1),
    externalId: z.string().min(1),
    workspace: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    metadata: Metadata.optional(),
    verifiedAt: z.number().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  });
  export type Endpoint = z.infer<typeof Endpoint>;

  export const ResolvedEndpoint = z.object({
    identity: Identity,
    endpoint: Endpoint,
  });
  export type ResolvedEndpoint = z.infer<typeof ResolvedEndpoint>;

  export const BlacklistKind = z.enum(["actor", "endpoint", "channel", "pattern"]);
  export type BlacklistKind = z.infer<typeof BlacklistKind>;

  export const BlacklistEntry = z.object({
    id: z.string().min(1),
    kind: BlacklistKind,
    value: z.string().min(1),
    reason: z.string().min(1).optional(),
    expiresAt: z.number().optional(),
    createdBy: z.string().min(1),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  });
  export type BlacklistEntry = z.infer<typeof BlacklistEntry>;

  export const ChannelGrantKind = z.enum([
    "trusted_channel",
    "broadcast_channel",
    "blocked_channel",
  ]);
  export type ChannelGrantKind = z.infer<typeof ChannelGrantKind>;

  export const InboundTreatment = z.enum(["full_access", "evidence_only", "drop"]);
  export type InboundTreatment = z.infer<typeof InboundTreatment>;

  export const ChannelGrant = z.object({
    id: z.string().min(1),
    surface: z.string().min(1),
    workspace: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    kind: ChannelGrantKind,
    defaultTier: TrustTier.optional(),
    inboundTreatment: InboundTreatment.optional(),
    createdBy: z.string().min(1),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  });
  export type ChannelGrant = z.infer<typeof ChannelGrant>;
}
