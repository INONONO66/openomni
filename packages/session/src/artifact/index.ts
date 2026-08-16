import type { Artifact as ArtifactSchema } from "@openomni/protocol";
import { Storage } from "../storage/storage";

export namespace Artifact {
  export async function store(
    sessionId: string,
    meta: ArtifactSchema.Meta,
    content: string,
  ): Promise<void> {
    Storage.get().artifact?.store(meta.id, sessionId, JSON.stringify(meta), content);
  }

  export async function get(
    artifactId: string,
  ): Promise<{ meta: ArtifactSchema.Meta; content: string } | null> {
    const row = Storage.get().artifact?.get(artifactId);
    if (!row) return null;
    return { meta: JSON.parse(row.meta) as ArtifactSchema.Meta, content: row.content };
  }
}
