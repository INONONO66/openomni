import type { AnyToolDefinition, Tool } from "@openomni/protocol";
import { monitorTool } from "../monitor";
import type { LedgerSession } from "@openomni/protocol";
import type { MachineHost } from "@openomni/machines";
import { createSendMessageTool, type MessagePort } from "../send-message";

export interface CatalogOrigin {
  readonly role: LedgerSession.Role;
  readonly depth: number;
  readonly sessionId: string;
}
import { createLlmTool, type LlmPort } from "../completion";
import { createRunCodeTool } from "../eval";
import type { composeCodemode } from "../../composition/codemode";
import { createProvisionTool, type ProvisionPort } from "../provision";
import { eraseTool, toolSpec } from "@openomni/agent";
import { createReadTool } from "../read";
import { createWriteTool } from "../write";
import { createEditTool } from "../edit";
import { createListTool } from "../ls";
import { createSearchTool } from "../grep";
import { createBashTool } from "../bash";

export interface CatalogPorts {
  readonly messages?: MessagePort;
  readonly machines?: MachineHost;
  readonly cells?: Pick<ReturnType<typeof composeCodemode>, "cell" | "bindTools">;
  readonly llm?: LlmPort;
  readonly provisioning?: ProvisionPort;
}

/**
 * The static catalog: every tool is constructed regardless of which ports the
 * composition wired, and a tool whose port is absent refuses at execution.
 * Nothing silently disappears (KERNEL §3.4).
 */
export function createTools(
  ports: CatalogPorts,
  origin: CatalogOrigin,
): readonly AnyToolDefinition[] {
  const tools: AnyToolDefinition[] = [
    eraseTool(createReadTool(ports)),
    eraseTool(createWriteTool(ports)),
    eraseTool(createEditTool(ports)),
    eraseTool(createListTool(ports)),
    eraseTool(createSearchTool(ports)),
    eraseTool(createBashTool(ports)),
  ];
  tools.push(
    eraseTool(monitorTool),
    eraseTool(createSendMessageTool(ports.messages)),
    eraseTool(createProvisionTool(ports.provisioning)),
    eraseTool(createRunCodeTool(ports.cells?.cell)),
    eraseTool(createLlmTool(ports.llm)),
  );
  const visible = tools.filter(
    (tool) =>
      tool.visibility.model.includes(origin.role) || tool.visibility.cell.includes(origin.role),
  );
  ports.cells?.bindTools(origin.sessionId, visible);
  return visible;
}

/** Schema-only exhaustive list used by repository conformance tooling. */
export const TOOL_DEFINITIONS: readonly AnyToolDefinition[] = createTools(
  {},
  { role: "resident", depth: 0, sessionId: "catalog" },
);

export function collectToolSpecs(): readonly Tool.Spec[] {
  return TOOL_DEFINITIONS.map(toolSpec);
}
