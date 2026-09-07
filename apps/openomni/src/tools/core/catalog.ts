import type { AnyToolDefinition, Tool } from "@openomni/protocol";
import { monitorTool } from "../monitor";
import type { LedgerSession } from "@openomni/protocol";
import type { MachineHost } from "@openomni/machines";
import { createSendMessageTool, type MessagePort } from "../send_message";

export interface CatalogOrigin {
  readonly role: LedgerSession.Role;
  readonly depth: number;
  readonly sessionId: string;
}
import { createApprovalTool, type ApprovalPort } from "../authority/approval";
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
  readonly approvals?: ApprovalPort;
  readonly cells?: Pick<ReturnType<typeof composeCodemode>, "cell" | "bindTools">;
  readonly llm?: LlmPort;
  readonly provisioning?: ProvisionPort;
}

/** Construct the immutable tool set once for a session. */
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
  tools.push(eraseTool(monitorTool));
  if (ports.messages !== undefined) tools.push(eraseTool(createSendMessageTool(ports.messages)));
  if (ports.approvals !== undefined) tools.push(eraseTool(createApprovalTool(ports.approvals)));
  if (ports.provisioning !== undefined)
    tools.push(eraseTool(createProvisionTool(ports.provisioning)));
  if (ports.cells !== undefined) tools.push(eraseTool(createRunCodeTool(ports.cells.cell)));
  if (ports.llm !== undefined) tools.push(eraseTool(createLlmTool(ports.llm)));
  const visible = tools.filter(
    (tool) =>
      tool.visibility.model.includes(origin.role) || tool.visibility.cell.includes(origin.role),
  );
  ports.cells?.bindTools(origin.sessionId, visible);
  return visible;
}

const ALL_PORTS = new Proxy(
  {},
  { get: () => new Proxy(() => undefined, { get: () => () => undefined }) },
) as CatalogPorts;
const CATALOG_ORIGIN: CatalogOrigin = { role: "resident", depth: 0, sessionId: "catalog" };
/** Schema-only exhaustive list used by repository conformance tooling. */
export const TOOL_DEFINITIONS: readonly AnyToolDefinition[] = createTools(
  ALL_PORTS,
  CATALOG_ORIGIN,
);

export function collectToolSpecs(): readonly Tool.Spec[] {
  return TOOL_DEFINITIONS.map(toolSpec);
}
