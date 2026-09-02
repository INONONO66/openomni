import type { Artifact } from "@openomni/protocol";
import { z } from "zod";
import { defineTool } from "../core/define";

export interface ArtifactsPort {
  store(sessionId: string, meta: Artifact.Meta, content: string): void;
  get(artifactId: string): { meta: Artifact.Meta; content: string } | null;
}

const Input = z.object({
  name: z.string().min(1).describe("A short title for the artifact."),
  content: z.string().min(1).describe("The full text to store."),
}).strict();

const Output = z.object({ id: z.string().min(1) }).strict();

export const WRITE_ARTIFACT_TOOL_NAME = "write_artifact";

export const writeArtifactTool = defineTool({
  name: WRITE_ARTIFACT_TOOL_NAME,
  category: "mutation",
  description:
    "Store text too large to keep quoting in the conversation — a cell's fetched dataset, a long report — under the current session. Returns the artifact id; the content is never echoed back.",
  input: Input,
  output: Output,
  safe: false,
  execution: { kind: "host" },
  placement: "host",
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
  bind: (ports, origin) => {
    if (ports.artifacts === undefined) return undefined;
    const artifacts = ports.artifacts;
    return async ({ name, content }) => {
      const id = crypto.randomUUID();
      const meta: Artifact.Meta = {
        id,
        sessionId: origin.sessionId,
        mimeType: "text/plain",
        title: name,
        version: 1,
        createdAt: new Date().toISOString(),
      };
      artifacts.store(origin.sessionId, meta, content);
      return { id };
    };
  },
  render: (_args, value) => `artifact stored: ${value.id}`,
});
