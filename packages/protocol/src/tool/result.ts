import { z } from "zod";
import { PlainValueSchema, type PlainValue } from "../json.js";

/**
 * D5 byte bound shared by the two JSON data fields: a details or
 * structuredContent value must serialize to at most this many JSON bytes.
 * Matches the machine-plane fs/exec payload bound.
 */
const TOOL_RESULT_JSON_MAX_BYTES = 262_144;

function withinJsonBound(value: PlainValue): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).length <= TOOL_RESULT_JSON_MAX_BYTES;
}

/** Bounded JSON profile for the D5 data fields; oversize values are refused at parse. */
export function toolResultJsonSchema() {
  return PlainValueSchema.refine(withinJsonBound, {
    message: `tool result JSON field exceeds ${TOOL_RESULT_JSON_MAX_BYTES} bytes`,
  });
}

/**
 * Fresh schemas keep policy validation isolated from mutation of public Tool.Result.
 *
 * D5 split (assumed: tool result split — content / details / structuredContent):
 * `content` is the model-facing text, `details` is UI/audit data, and
 * `structuredContent` is typed data for code consumers. `output` is the
 * pre-split model text kept readable for historical rows — new results write
 * `content`; readers go through {@link toolResultText} for the fallback.
 */
export function toolResultSchema() {
  return z
    .object({
      id: z.string(),
      toolCallId: z.string(),
      // Additive-optional denormalized name; historical results may only have the call id.
      toolName: z.string().optional(),
      content: z.string().optional(),
      output: z.string().optional(),
      details: toolResultJsonSchema().optional(),
      structuredContent: toolResultJsonSchema().optional(),
      isError: z.boolean().optional(),
      settlement: z.enum(["settled", "unknown"]).optional(),
    })
    .refine((result) => result.content !== undefined || result.output !== undefined, {
      message: "tool result requires content (or historical output)",
    });
}

/**
 * The ONE reader of a tool result's model-facing text: new rows carry
 * `content`, historical rows only `output`. The schema refuses a result with
 * neither, so the empty-string arm is unreachable for parsed values.
 */
export function toolResultText(result: {
  readonly content?: string | undefined;
  readonly output?: string | undefined;
}): string {
  return result.content ?? result.output ?? "";
}
