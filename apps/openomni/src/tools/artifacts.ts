import type { Artifact } from "@openomni/protocol";
import type { Tool } from "@openomni/protocol";
import { z } from "zod";

/**
 * Artifact persistence without knowing how the host stores: the ledger's
 * Artifact namespace satisfies this exactly, and tests substitute memory.
 */
export interface ArtifactsPort {
  store(sessionId: string, meta: Artifact.Meta, content: string): void;
  get(artifactId: string): { meta: Artifact.Meta; content: string } | null;
}

const WriteInput = z
  .object({
    name: z.string().min(1).describe("A short title for the artifact."),
    content: z.string().min(1).describe("The full text to store."),
  })
  .strict();

const ReadInput = z
  .object({
    artifactId: z.string().min(1).describe("The id write_artifact returned."),
  })
  .strict();

export const WRITE_ARTIFACT_TOOL_NAME = "write_artifact";
export const READ_ARTIFACT_TOOL_NAME = "read_artifact";

const WRITE_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "content"],
  properties: {
    name: { type: "string", minLength: 1, description: "A short title for the artifact." },
    content: { type: "string", minLength: 1, description: "The full text to store." },
  },
};

const READ_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["artifactId"],
  properties: {
    artifactId: { type: "string", minLength: 1, description: "The id write_artifact returned." },
  },
};

export function writeArtifactToolSpec(): Tool.Spec {
  return {
    name: WRITE_ARTIFACT_TOOL_NAME,
    description:
      "Store text too large to keep quoting in the conversation — a cell's fetched dataset, a long report — under the current session. Returns the artifact id; the content is never echoed back.",
    inputSchema: WRITE_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function readArtifactToolSpec(): Tool.Spec {
  return {
    name: READ_ARTIFACT_TOOL_NAME,
    description: "Read back the full content of an artifact stored by write_artifact, by its id.",
    inputSchema: READ_INPUT_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

export function writeArtifactToolExecutor(artifacts: ArtifactsPort, sessionId: string) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = WriteInput.safeParse(rawInput);
    if (!parsed.success) {
      return `write_artifact refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const { name, content } = parsed.data;
    const id = crypto.randomUUID();
    const meta: Artifact.Meta = {
      id,
      sessionId,
      mimeType: "text/plain",
      title: name,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    artifacts.store(sessionId, meta, content);
    return `artifact stored: ${id}`;
  };
}

export function readArtifactToolExecutor(artifacts: ArtifactsPort) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = ReadInput.safeParse(rawInput);
    if (!parsed.success) {
      return `read_artifact refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const found = artifacts.get(parsed.data.artifactId);
    if (found === null) {
      return `read_artifact refused: no artifact with id ${parsed.data.artifactId}`;
    }
    return found.content;
  };
}
