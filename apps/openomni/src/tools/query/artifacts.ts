import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";
import type { ArtifactsPort } from "../mutation/artifacts";

const Input = z.object({
  artifactId: z.string().min(1).describe("The id write_artifact returned."),
}).strict();

export const READ_ARTIFACT_TOOL_NAME = "read_artifact";

export const readArtifactTool = defineTool({
  name: READ_ARTIFACT_TOOL_NAME,
  category: "query",
  description: "Read back the full content of an artifact stored by write_artifact, by its id.",
  input: Input,
  output: z.string(),
  safe: true,
  execution: { kind: "host" },
  placement: "host",
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
  bind: (ports) => {
    if (ports.artifacts === undefined) return undefined;
    const artifacts: ArtifactsPort = ports.artifacts;
    return async ({ artifactId }) => {
      const found = artifacts.get(artifactId);
      if (found === null) {
        throw new ToolRefused(READ_ARTIFACT_TOOL_NAME, `no artifact with id ${artifactId}`);
      }
      return found.content;
    };
  },
  render: (_args, content) => content,
});
