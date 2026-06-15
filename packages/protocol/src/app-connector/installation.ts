import { z } from "zod";
import { Policy } from "../policy/index.js";
import { Definition } from "./definition.js";
import { nonEmptyString, positiveInteger } from "./schema-primitives.js";

export const InstallationStatus = z.enum([
  "registered",
  "pending_consent",
  "consented",
  "enabled",
  "disabled",
  "verification_failed",
]);
export type InstallationStatus = z.infer<typeof InstallationStatus>;

export const Consent = z
  .object({
    grantedBy: nonEmptyString,
    grantedAt: positiveInteger,
    credentials: z.array(nonEmptyString).optional(),
    capabilities: z.array(nonEmptyString).optional(),
    permissions: z.array(Policy.Permission).optional(),
  })
  .strict();
export type Consent = z.infer<typeof Consent>;

export const WorkspaceIdentity = z
  .object({
    repoPath: nonEmptyString,
    worktreePath: nonEmptyString,
    repoPathHash: nonEmptyString,
    worktreePathHash: nonEmptyString,
  })
  .strict();
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentity>;

export const Installation = z
  .object({
    id: nonEmptyString,
    connectorId: nonEmptyString,
    connectorVersion: nonEmptyString,
    endpointId: nonEmptyString,
    definition: Definition,
    detectedVersion: nonEmptyString.optional(),
    testedVersions: nonEmptyString,
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

export const VerificationFailureReason = z.enum([
  "missing_candidate",
  "detect_failed",
  "unsupported_version",
]);
export type VerificationFailureReason = z.infer<typeof VerificationFailureReason>;
