import { Extension } from "@openomni/protocol";
import { z } from "zod";
import { truncateAuditText } from "./audit-util";

export interface ExtensionValidationSuccess {
  readonly success: true;
  readonly manifest: Extension.Manifest;
}

export interface ExtensionValidationFailure {
  readonly success: false;
  readonly errors: readonly string[];
}

export type ExtensionValidationResult = ExtensionValidationSuccess | ExtensionValidationFailure;

/** @internal Manager audit payload schema; not a canonical manifest schema. */
export const AuditManifestSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  permissionCount: z.number(),
  contributes: z
    .object({
      agents: z.number(),
      tools: z.number(),
      skills: z.number(),
      mcpServers: z.number(),
      middlewares: z.number(),
      surfaces: z.number(),
    })
    .optional(),
  components: Extension.Contributes.optional(),
  provenance: z
    .object({
      manifestHash: z.string(),
      packageHash: z.string().optional(),
      signedBy: z.string().optional(),
      createdByRunId: z.string().optional(),
      sourceSessionId: z.string().optional(),
    })
    .optional(),
  compatibility: z.object({ openomni: z.string() }).optional(),
});
export type ExtensionManifestSummary = z.infer<typeof AuditManifestSummarySchema>;

/** @internal Builds the audit-safe manifest summary recorded by ExtensionManager lifecycle events. */
export function auditManifestSummary(
  manifest: Extension.Manifest,
  options: { readonly includeComponents?: boolean } = {},
): ExtensionManifestSummary {
  const contributes = manifest.contributes;
  return {
    id: manifest.id,
    name: truncateAuditText(manifest.name),
    version: truncateAuditText(manifest.version),
    description: truncateAuditText(manifest.description),
    ...(manifest.author !== undefined ? { author: truncateAuditText(manifest.author) } : {}),
    ...(manifest.homepage !== undefined ? { homepage: truncateAuditText(manifest.homepage) } : {}),
    permissionCount: manifest.permissions?.length ?? 0,
    ...(contributes !== undefined
      ? {
          contributes: {
            agents: contributes.agents?.length ?? 0,
            tools: contributes.tools?.length ?? 0,
            skills: contributes.skills?.length ?? 0,
            mcpServers: contributes.mcpServers?.length ?? 0,
            middlewares: contributes.middlewares?.length ?? 0,
            surfaces: contributes.surfaces?.length ?? 0,
          },
        }
      : {}),
    ...(options.includeComponents === true && contributes !== undefined
      ? { components: contributes }
      : {}),
    ...(manifest.provenance !== undefined
      ? {
          provenance: {
            manifestHash: truncateAuditText(manifest.provenance.manifestHash),
            ...(manifest.provenance.packageHash !== undefined
              ? { packageHash: truncateAuditText(manifest.provenance.packageHash) }
              : {}),
            ...(manifest.provenance.signedBy !== undefined
              ? { signedBy: truncateAuditText(manifest.provenance.signedBy) }
              : {}),
            ...(manifest.provenance.createdByRunId !== undefined
              ? { createdByRunId: truncateAuditText(manifest.provenance.createdByRunId) }
              : {}),
            ...(manifest.provenance.sourceSessionId !== undefined
              ? { sourceSessionId: truncateAuditText(manifest.provenance.sourceSessionId) }
              : {}),
          },
        }
      : {}),
    ...(manifest.compatibility !== undefined
      ? { compatibility: { openomni: truncateAuditText(manifest.compatibility.openomni) } }
      : {}),
  };
}

/** @internal Parses an extension manifest for ExtensionManager operations. */
export function parseExtensionManifest(manifest: unknown): ExtensionValidationResult {
  const parsed = Extension.Manifest.safeParse(manifest);
  if (parsed.success) {
    return { success: true, manifest: parsed.data };
  }

  return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
}

/** @internal Builds the audit resource label for manifest validation. */
export function auditValidationResource(manifest: unknown): string {
  return readStringField(manifest, "id") ?? "unknown";
}

/** @internal Builds the audit input payload for manifest validation. */
export function auditValidationInput(manifest: unknown): Record<string, unknown> {
  const record = manifestRecord(manifest);
  if (!record) {
    return { valueType: manifest === null ? "null" : typeof manifest };
  }

  return {
    ...(readStringField(record, "id") !== undefined
      ? { id: truncateAuditText(readStringField(record, "id") ?? "") }
      : {}),
    ...(readStringField(record, "version") !== undefined
      ? { version: truncateAuditText(readStringField(record, "version") ?? "") }
      : {}),
    ...(readStringField(record, "name") !== undefined
      ? { name: truncateAuditText(readStringField(record, "name") ?? "") }
      : {}),
    fieldCount: Object.keys(record).length,
    hasContributes: typeof record.contributes === "object" && record.contributes !== null,
    permissionCount: Array.isArray(record.permissions) ? record.permissions.length : 0,
  };
}

function readStringField(value: unknown, field: string): string | undefined {
  const record = manifestRecord(value);
  const raw = record?.[field];
  return typeof raw === "string" ? truncateAuditText(raw) : undefined;
}

function manifestRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
