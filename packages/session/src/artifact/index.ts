import { Artifact as ArtifactSchema } from "@openomni/protocol";

// Internal storage using key patterns:
//   content:  artifact:{sessionId}:{artifactId}:v{version}
//   index:    artifact:{sessionId}:index
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
  }

  export async function get(
    artifactId: string,
  ): Promise<{ meta: ArtifactSchema.Meta; content: string } | null> {
    const sessionId = artifactSessions.get(artifactId);
    if (!sessionId) return null;

    const idxKey = indexKey(sessionId);
    const metas = indices.get(idxKey) ?? [];
    const matching = metas.filter((m) => m.id === artifactId);
    if (matching.length === 0) return null;

    const latest = matching.reduce((a, b) => (a.version > b.version ? a : b));
    const content = contents.get(contentKey(sessionId, artifactId, latest.version));
    if (content === undefined) return null;

    return { meta: latest, content };
  }

  export async function list(sessionId: string): Promise<ArtifactSchema.Meta[]> {
    const idxKey = indexKey(sessionId);
    const metas = indices.get(idxKey) ?? [];

    const latest = new Map<string, ArtifactSchema.Meta>();
    for (const meta of metas) {
      const existing = latest.get(meta.id);
      if (!existing || meta.version > existing.version) {
        latest.set(meta.id, meta);
      }
    }

    return Array.from(latest.values());
  }

  export async function versions(artifactId: string): Promise<ArtifactSchema.Meta[]> {
    const sessionId = artifactSessions.get(artifactId);
    if (!sessionId) return [];

    const idxKey = indexKey(sessionId);
    const metas = indices.get(idxKey) ?? [];
    return metas.filter((m) => m.id === artifactId).sort((a, b) => a.version - b.version);
  }

  export function _reset(): void {
    contents.clear();
    indices.clear();
    artifactSessions.clear();
  }
}
