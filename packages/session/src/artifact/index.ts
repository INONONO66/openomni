import type { Artifact as ArtifactSchema } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

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
    return { meta: JSON.parse(row.meta) as ArtifactSchema.Meta, content: row.content };
  }
}
