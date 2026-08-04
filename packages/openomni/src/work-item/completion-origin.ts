import type { WorkItem } from "@openomni/protocol";
import { z } from "zod";

const CompletionIdentity = z
  .object({
    kind: z.enum(["resident", "worker", "external_actor"]),
    id: z.string().min(1),
  })
  .strict();

const FixedCompletionSourceOrigin = z.discriminatedUnion("source", [
  z.object({ source: z.literal("internal_worker") }).strict(),
  z.object({ source: z.literal("connector_worker") }).strict(),
  z.object({ source: z.literal("api") }).strict(),
  z.object({ source: z.literal("a2a") }).strict(),
  z.object({ source: z.literal("human") }).strict(),
  z.object({ source: z.literal("replay") }).strict(),
  z.object({ source: z.literal("recovery") }).strict(),
  z.object({ source: z.literal("resident") }).strict(),
]);

const QualifiedCompletionSourceOrigin = z.discriminatedUnion("source", [
  z.object({ source: z.literal("sdk"), identity: CompletionIdentity }).strict(),
  z.object({ source: z.literal("internal"), identity: CompletionIdentity }).strict(),
]);

export const CompletionSourceOrigin = z.union([
  FixedCompletionSourceOrigin,
  QualifiedCompletionSourceOrigin,
]);
export type CompletionSourceOrigin = z.infer<typeof CompletionSourceOrigin>;

const fixedOriginProjection = {
  internal_worker: "worker",
  connector_worker: "worker",
  api: "external_actor",
  a2a: "external_actor",
  human: "external_actor",
  replay: "replay",
  recovery: "recovery",
  resident: "resident",
} as const satisfies Record<
  z.infer<typeof FixedCompletionSourceOrigin>["source"],
  WorkItem.CompletionOrigin
>;

const identityOriginProjection = {
  resident: "resident",
  worker: "worker",
  external_actor: "external_actor",
} as const satisfies Record<z.infer<typeof CompletionIdentity>["kind"], WorkItem.CompletionOrigin>;

export function projectCompletionOrigin(input: unknown): WorkItem.CompletionOrigin {
  const origin = CompletionSourceOrigin.parse(input);
  if (origin.source === "sdk" || origin.source === "internal") {
    return identityOriginProjection[origin.identity.kind];
  }
  return fixedOriginProjection[origin.source];
}
