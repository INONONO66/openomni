import type { Artifact } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";

export interface ArtifactsPort {
  store(sessionId: string, meta: Artifact.Meta, content: string): void;
  get(artifactId: string): { meta: Artifact.Meta; content: string } | null;
}

const Input = z
  .object({
    op: z.union([z.literal("write"), z.literal("read")]),
    name: z.string().min(1).optional().describe("Write only: a short title for the artifact."),
    content: z.string().min(1).optional().describe("Write only: the full text to store."),
    artifactId: z.string().min(1).optional().describe("Read only: the artifact id."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.op === "write" && (value.name === undefined || value.content === undefined)) {
      ctx.addIssue({ code: "custom", message: "write requires name and content" });
    }
    if (value.op === "read" && value.artifactId === undefined) {
      ctx.addIssue({ code: "custom", message: "read requires artifactId" });
    }
  });
const Output = z.discriminatedUnion("op", [
  z.object({ op: z.literal("write"), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("read"), content: z.string() }).strict(),
]);

export const ARTIFACTS_TOOL_NAME = "artifacts";

export function createArtifactsTool(artifacts: ArtifactsPort) {
  return defineTool({
    name: ARTIFACTS_TOOL_NAME,
    category: "mutation",
    description:
      "Write large text under the current session or read it back by artifact id. Use op=write or op=read.",
    input: Input,
    output: Output,
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    execute: async (input, ctx) => {
      if (input.op === "read") {
        const found = artifacts.get(input.artifactId as string);
        if (found === null)
          throw new ToolRefused(ARTIFACTS_TOOL_NAME, `no artifact with id ${input.artifactId}`);
        return { op: "read" as const, content: found.content };
      }
      const id = crypto.randomUUID();
      const meta: Artifact.Meta = {
        id,
        sessionId: ctx.sessionId,
        mimeType: "text/plain",
        title: input.name as string,
        version: 1,
        createdAt: new Date().toISOString(),
      };
      artifacts.store(ctx.sessionId, meta, input.content as string);
      return { op: "write" as const, id };
    },
    render: (_args, value) =>
      value.op === "read" ? value.content : `artifact stored: ${value.id}`,
  });
}
