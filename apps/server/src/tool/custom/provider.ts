import type { Tool } from "@openomni/protocol";
import type {
  NativeTool,
  ToolCategory,
  ToolExecutionContext,
  ToolProvider,
} from "@openomni/openomni";
import { createOpenSearchNativeTools } from "./opensearch";

export class CustomToolProvider implements ToolProvider {
  readonly name = "custom";
  readonly category: ToolCategory = "system";

  private tools: NativeTool[] = [];

  constructor(extraTools: NativeTool[] = []) {
    // The production custom-tool catalog is exactly the OpenSearch web tools.
    // No mock/test tools are baked in (#521): E2E fixtures that need a stub
    // tool inject it through the `extraTools` seam below, never through here.
    const defaultTools = createOpenSearchNativeTools();
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

  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
    const tool = this.tools.find((t) => t.spec.name === call.tool);
    if (!tool) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        toolName: call.tool,
        output: `Unknown custom tool: ${call.tool}`,
        isError: true,
      });
    }
    return context === undefined ? tool.execute(call) : tool.execute(call, context);
  }
}
