import type { Execution, Tool } from "@openomni/protocol";
import type { ServerConfig } from "../config";
import { createToolExecutor } from "../tool/executor";
import type { NativeTool } from "../tool/types";

function expandRequestedToolNames(tools: Tool.Spec[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    names.add(tool.name);
    names.add(tool.name.replace(/_/g, "."));
  }
  return names;
}

export function resolveWorkerDbPath(config: Pick<ServerConfig, "storage">): string {
  return process.env.OPENOMNI_DB_PATH ?? config.storage.dbPath;
}

export function selectRequestedTools(
  availableTools: NativeTool[],
  requestedTools: Execution.Request["tools"],
): NativeTool[] {
  const requestedNames = expandRequestedToolNames(requestedTools);
  if (requestedNames.size === 0) {
    return [];
  }

  return availableTools.filter((tool) => requestedNames.has(tool.spec.name));
}

export function createExecutionToolContext(
  request: Pick<Execution.Request, "tools" | "permissions" | "toolConfig">,
  availableTools: NativeTool[],
): {
  tools?: Execution.Request["tools"];
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>;
} {
  if ((request.tools?.length ?? 0) === 0) {
    return {};
  }

  const selectedTools = selectRequestedTools(availableTools, request.tools);
  return {
    tools: request.tools,
    toolExecutor: createToolExecutor({
      tools: selectedTools,
      config: {
        permissions: request.permissions,
        workspaceRoot: request.toolConfig?.workspaceRoot,
      },
    }),
  };
}
