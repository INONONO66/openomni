import { Artifact as ArtifactSchema } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

const LEGACY_MIME_TYPE = "application/octet-stream";
const LEGACY_CREATED_AT = "1970-01-01T00:00:00.000Z";

function parsePersistedMeta(serialized: string): ArtifactSchema.Meta {
  const value: unknown = JSON.parse(serialized);
  const current = ArtifactSchema.Meta.safeParse(value);
  if (current.success) return current.data;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw current.error;

  const legacy = value as Record<string, unknown>;
  const version =
    typeof legacy.version === "number" && Number.isFinite(legacy.version)
      ? Math.max(1, Math.trunc(legacy.version))
      : 1;
  const mimeType =
    typeof legacy.mimeType === "string" && legacy.mimeType.trim().length > 0
      ? legacy.mimeType
      : LEGACY_MIME_TYPE;
  const createdAt =
    typeof legacy.createdAt === "string" && legacy.createdAt.trim().length > 0
      ? legacy.createdAt
      : LEGACY_CREATED_AT;

  return ArtifactSchema.Meta.parse({ ...legacy, version, mimeType, createdAt });
}

export namespace Artifact {
  function subAdapter(): NonNullable<Storage.Adapter["artifact"]> {
    return requireSubAdapter(
      Storage.get().artifact,
      "Storage adapter does not implement artifact — artifact persistence fails closed",
    );
  }

  export function store(sessionId: string, meta: ArtifactSchema.Meta, content: string): void {
    subAdapter().store(meta.id, sessionId, JSON.stringify(meta), content);
  }

  export function get(artifactId: string): { meta: ArtifactSchema.Meta; content: string } | null {
    const row = subAdapter().get(artifactId);
    if (!row) return null;
    return { meta: parsePersistedMeta(row.meta), content: row.content };
  }
}
