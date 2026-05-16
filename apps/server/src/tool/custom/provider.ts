import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider, ToolSource } from "@openomni/openomni";

export class CustomToolProvider implements ToolProvider {
  readonly name = "custom";
  readonly category: ToolCategory = "system";

  private tools: NativeTool[] = [];

  constructor(extraTools: NativeTool[] = []) {
    this.tools = [
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
      ...extraTools,
    ];
  }

  listTools(): NativeTool[] {
    return this.tools;
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const tool = this.tools.find((t) => t.spec.name === call.tool);
    if (!tool) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `Unknown custom tool: ${call.tool}`,
        isError: true,
      });
    }
    return tool.execute(call);
  }
}
