import { createOpenSearchTools } from "opensearch-ai-sdk/node";
import { z } from "zod";
import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolExecutionContext, ToolSource } from "@openomni/openomni";

const tools = createOpenSearchTools();

const webSearchInput = z.object({
  query: z.string().min(1),
  numResults: z.number().int().positive().max(15).optional(),
});

const webFetchInput = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
  maxCharacters: z.number().int().positive().optional(),
});

const webSearchJsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural language search query. Describe the ideal page, not just keywords.",
    },
    numResults: {
      type: "integer",
      minimum: 1,
      maximum: 15,
      description: "Number of search results to return. Defaults to 5.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const webFetchJsonSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      items: { type: "string", format: "uri" },
      minItems: 1,
      maxItems: 10,
      description: "URLs to read. Batch multiple URLs in one call.",
    },
    maxCharacters: {
      type: "integer",
      minimum: 1,
      description: "Maximum characters to extract per page. Defaults to 12000.",
    },
  },
  required: ["urls"],
  additionalProperties: false,
} as const;

function executionOptions(call: Tool.Call, context?: ToolExecutionContext) {
  return {
    toolCallId: call.id,
    messages: [],
    ...(context?.signal !== undefined && { abortSignal: context.signal }),
  };
}

export function createOpenSearchNativeTools(): NativeTool[] {
  const source: ToolSource = "server";
  return [
    {
      spec: {
        name: "web_search",
        description: tools.web_search.description,
        inputSchema: webSearchJsonSchema,
      },
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      source,
      category: "custom",
      execute: async (call, context) => {
        const output = await tools.web_search.execute(
          webSearchInput.parse(call.input),
          executionOptions(call, context),
        );
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: JSON.stringify(output),
        };
      },
    },
    {
      spec: {
        name: "web_fetch",
        description: tools.web_fetch.description,
        inputSchema: webFetchJsonSchema,
      },
      riskTier: 0,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      source,
      category: "custom",
      execute: async (call, context) => {
        const output = await tools.web_fetch.execute(
          webFetchInput.parse(call.input),
          executionOptions(call, context),
        );
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: JSON.stringify(output),
        };
      },
    },
  ];
}
