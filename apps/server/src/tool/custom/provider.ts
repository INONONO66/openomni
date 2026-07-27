import { Execution, type Tool } from "@openomni/protocol";
import {
  digestEffectValue,
  toWorkspaceRef,
  type NativeTool,
  type ToolCategory,
  type ToolEffectLedgerPortV1,
  type ToolExecutionContext,
  type ToolProvider,
  type ToolSource,
  type WorkspaceIdentity,
} from "@openomni/openomni";
import { createOpenSearchNativeTools } from "./opensearch";

export interface CustomToolProviderOptions {
  readonly extraTools?: readonly NativeTool[];
  readonly effects: ToolEffectLedgerPortV1;
  readonly workspaceIdentity: WorkspaceIdentity;
}

function canonicalEffectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEffectValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalEffectValue(nested)]),
    );
  }
  return value;
}

function isReadOnly(tool: NativeTool, input: unknown): boolean {
  try {
    return typeof tool.isReadOnly === "function" ? tool.isReadOnly(input) : tool.isReadOnly;
  } catch {
    return false;
  }
}

function requireAcceptedEffectReceipt(
  receipt: Awaited<ReturnType<ToolEffectLedgerPortV1["appendIntent"]>>,
): void {
  if (receipt.version === "tool-effect-append-receipt-v1" && receipt.status === "accepted") return;
  throw new Error(
    `effect ledger denied: ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`,
  );
}

function customEffectIntent(
  call: Tool.Call,
  tool: NativeTool,
  workspace: WorkspaceIdentity,
  context: ToolExecutionContext | undefined,
) {
  const inputDigest = digestEffectValue(JSON.stringify(canonicalEffectValue(call.input)));
  const scope = Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(workspace),
    resources: [
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: "custom.v1",
        targetDigest: digestEffectValue(tool.spec.name),
      },
    ],
    resolver: { id: "custom-registered-tool-v1", version: "1", inputDigest },
    containment: "none",
    mutationClass: "mutating",
  });
  const sourceRef = digestEffectValue(
    JSON.stringify({
      version: "tool-effect-source-v1",
      sessionId: context?.traceContext?.sessionId ?? null,
      runId: context?.traceContext?.runId ?? null,
      toolCallId: call.id,
      operation: tool.spec.name,
      operationVersion: "1",
      scope,
    }),
  );
  return Object.freeze({
    version: "tool-effect-intent-v1" as const,
    effectId: `tool-effect:${sourceRef}`,
    sourceRef,
    toolCallId: call.id,
    operation: tool.spec.name,
    operationVersion: "1" as const,
    scope,
    execution: {
      sessionId: context?.traceContext?.sessionId ?? "",
      runId: context?.traceContext?.runId ?? "",
    },
  });
}

async function settleCustomEffect(
  effects: ToolEffectLedgerPortV1,
  intent: ReturnType<typeof customEffectIntent>,
  status: "confirmed" | "failed" | "unknown",
): Promise<void> {
  requireAcceptedEffectReceipt(
    await effects.appendSettlement({
      version: "tool-effect-settlement-v1",
      effectId: intent.effectId,
      sourceRef: intent.sourceRef,
      status,
    }),
  );
}

export class CustomToolProvider implements ToolProvider {
  readonly name = "custom";
  readonly category: ToolCategory = "system";

  private tools: NativeTool[] = [];

  constructor(private readonly options: CustomToolProviderOptions) {
    const extraTools = [...(options.extraTools ?? [])];
    const builtInTools: NativeTool[] = [
      {
        spec: {
          name: "weather_lookup",
          description:
            "Look up current weather for a given city. Returns temperature and conditions.",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name to look up weather for" },
            },
            required: ["city"],
          },
        },
        riskTier: 0,
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        source: "server" as ToolSource,
        category: "custom",
        execute: async (call: Tool.Call): Promise<Tool.Result> => {
          const input = call.input as { city: string };
          const city = input.city || "Unknown";
          const mockWeather: Record<string, { temp: number; condition: string }> = {
            seoul: { temp: 18, condition: "Partly Cloudy" },
            tokyo: { temp: 22, condition: "Sunny" },
            "new york": { temp: 15, condition: "Rainy" },
            london: { temp: 12, condition: "Foggy" },
          };
          const weather = mockWeather[city.toLowerCase()] ?? { temp: 20, condition: "Clear" };
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: JSON.stringify({
              city,
              temperature: `${weather.temp}°C`,
              condition: weather.condition,
              source: "OpenOmni Custom Tool (E2E Test)",
            }),
          };
        },
      },
    ];

    const defaultTools = [...builtInTools, ...createOpenSearchNativeTools()];
    const duplicate = extraTools.find((candidate) =>
      defaultTools.some((base) => base.spec.name === candidate.spec.name),
    );
    if (duplicate) {
      throw new Error(`Duplicate custom tool name: ${duplicate.spec.name}`);
    }
    const extraDuplicates = extraTools.filter(
      (tool, i) => extraTools.findIndex((t) => t.spec.name === tool.spec.name) !== i,
    );
    const firstDuplicate = extraDuplicates[0];
    if (firstDuplicate) {
      throw new Error(`Duplicate custom tool name: ${firstDuplicate.spec.name}`);
    }

    this.tools = [...defaultTools, ...extraTools];
  }

  listTools(): NativeTool[] {
    return this.tools;
  }

  async execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
    const tool = this.tools.find((t) => t.spec.name === call.tool);
    if (!tool) {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `Unknown custom tool: ${call.tool}`,
        isError: true,
      };
    }
    if (isReadOnly(tool, call.input)) {
      return context === undefined ? tool.execute(call) : tool.execute(call, context);
    }

    const intent = customEffectIntent(call, tool, this.options.workspaceIdentity, context);
    requireAcceptedEffectReceipt(await this.options.effects.appendIntent(intent));
    let result: Tool.Result;
    try {
      result = context === undefined ? await tool.execute(call) : await tool.execute(call, context);
    } catch (error) {
      await settleCustomEffect(this.options.effects, intent, "unknown");
      throw error;
    }
    await settleCustomEffect(
      this.options.effects,
      intent,
      result.settlement === "unknown" ? "unknown" : result.isError ? "failed" : "confirmed",
    );
    return result;
  }
}
