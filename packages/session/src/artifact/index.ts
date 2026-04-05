import type { Artifact as ArtifactSchema } from "@openomni/protocol";
import { Storage } from "../storage/storage";

// Write-through: in-memory Maps track version history, Storage.Adapter.artifact persists latest.
const contents = new Map<string, string>();
const indices = new Map<string, ArtifactSchema.Meta[]>();
const artifactSessions = new Map<string, string>();

function contentKey(sessionId: string, artifactId: string, version: number): string {
  return `artifact:${sessionId}:${artifactId}:v${version}`;
}

function indexKey(sessionId: string): string {
  return `artifact:${sessionId}:index`;
}

export namespace Artifact {
  export async function store(
    sessionId: string,
    meta: ArtifactSchema.Meta,
    content: string,
  ): Promise<void> {
    const key = contentKey(sessionId, meta.id, meta.version);
    contents.set(key, content);

    const idxKey = indexKey(sessionId);
    const metas = indices.get(idxKey) ?? [];
    metas.push(meta);
    indices.set(idxKey, metas);

    artifactSessions.set(meta.id, sessionId);

    Storage.get().artifact?.store(meta.id, sessionId, JSON.stringify(meta), content);
  }

  export async function get(
    artifactId: string,
  ): Promise<{ meta: ArtifactSchema.Meta; content: string } | null> {
    const sessionId = artifactSessions.get(artifactId);
    if (sessionId) {
      const idxKey = indexKey(sessionId);
      const metas = indices.get(idxKey) ?? [];
      const matching = metas.filter((m) => m.id === artifactId);
      if (matching.length > 0) {
        const latest = matching.reduce((a, b) => (a.version > b.version ? a : b));
        const content = contents.get(contentKey(sessionId, artifactId, latest.version));
        if (content !== undefined) {
          return { meta: latest, content };
        }
      }
    }

    const adapter = Storage.get().artifact;
    if (adapter) {
      const row = adapter.get(artifactId);
      if (row) {
        const meta = JSON.parse(row.meta) as ArtifactSchema.Meta;
        return { meta, content: row.content };
      }
    }

    return null;
  }

  export async function list(sessionId: string): Promise<ArtifactSchema.Meta[]> {
    const idxKey = indexKey(sessionId);
    const metas = indices.get(idxKey);
    if (metas && metas.length > 0) {
      const latest = new Map<string, ArtifactSchema.Meta>();
      for (const meta of metas) {
        const existing = latest.get(meta.id);
        if (!existing || meta.version > existing.version) {
          latest.set(meta.id, meta);
        }
      }
      return Array.from(latest.values());
    }

    const adapter = Storage.get().artifact;
    if (adapter) {
      return adapter.list(sessionId).map((row) => JSON.parse(row.meta) as ArtifactSchema.Meta);
    }

    return [];
  }

  export async function versions(artifactId: string): Promise<ArtifactSchema.Meta[]> {
    const sessionId = artifactSessions.get(artifactId);
    if (sessionId) {
      const idxKey = indexKey(sessionId);
      const metas = indices.get(idxKey) ?? [];
      const matching = metas.filter((m) => m.id === artifactId);
      if (matching.length > 0) {
        return matching.sort((a, b) => a.version - b.version);
      }
    }

    const adapter = Storage.get().artifact;
    if (adapter) {
      const row = adapter.get(artifactId);
      if (row) {
        return [JSON.parse(row.meta) as ArtifactSchema.Meta];
      }
    }

    return [];
  }

  export function _reset(): void {
    contents.clear();
    indices.clear();
    artifactSessions.clear();
  }
}
