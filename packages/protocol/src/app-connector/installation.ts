import { z } from "zod";
import { Definition, nonEmptyString, positiveInteger, Requires } from "./definition.js";

export const InstallationStatus = z.enum([
  "registered",
  "pending_consent",
  "consented",
  "enabled",
  "disabled",
  "verification_failed",
]);
export type InstallationStatus = z.infer<typeof InstallationStatus>;

export const Consent = Requires.extend({
  grantedBy: nonEmptyString,
  grantedAt: positiveInteger,
});
export type Consent = z.infer<typeof Consent>;

const WorkspaceIdentity = z
  .object({
    repoPath: nonEmptyString,
    worktreePath: nonEmptyString,
    repoPathHash: nonEmptyString,
    worktreePathHash: nonEmptyString,
  })
  .strict();

export const Installation = z
  .object({
    id: nonEmptyString,
    connectorId: nonEmptyString,
    connectorVersion: nonEmptyString,
    endpointId: nonEmptyString,
    definition: Definition,
    detectedVersion: nonEmptyString.optional(),
    status: InstallationStatus,
    registeredBy: nonEmptyString,
    workspace: WorkspaceIdentity.optional(),
    consent: Consent.optional(),
    createdAt: positiveInteger,
    updatedAt: positiveInteger,
  })
  .strict()
  .refine((record) => record.definition.id === record.connectorId, {
    message: "definition id must match connectorId",
    path: ["definition", "id"],
  })
  .refine((record) => record.definition.version === record.connectorVersion, {
    message: "definition version must match connectorVersion",
    path: ["definition", "version"],
  })
  .refine((record) => record.status !== "enabled" || record.consent !== undefined, {
    message: "enabled installation requires owner consent",
    path: ["consent"],
  });
export type Installation = z.infer<typeof Installation>;
