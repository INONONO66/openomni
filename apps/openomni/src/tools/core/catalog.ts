import { eraseTool } from "@openomni/agent";
import type { AnyToolDefinition, LedgerSession } from "@openomni/protocol";
import type { FilePorts } from "./filesystem";
import { createBashTool } from "../bash";
import { createCompletionTool, type LlmPort } from "../completion";
import { createEditTool } from "../edit";
import { createEvalTool, type Cell } from "../eval";
import { createFindTool } from "../find";
import { createGrepTool } from "../grep";
import { createLsTool } from "../ls";
import { createMonitorTool } from "../monitor";
import type { MonitorPorts } from "./monitor-ports";
import { createProvisionTool } from "../provision";
import type { ProvisionPort } from "../../provisioning/channels";
import { createReadTool } from "../read";
import { createSendMessageTool, type MessagePort } from "../send-message";
import { createWriteTool } from "../write";

export interface CatalogOrigin {
  readonly role: LedgerSession.Role;
  readonly sessionId: string;
}

/** Every dependency is declared; unavailable capabilities are explicitly undefined. */
export interface ToolPorts {
  readonly alarms: MonitorPorts | undefined;
  readonly messages: MessagePort | undefined;
  readonly machines: FilePorts["machines"];
  readonly cells: { readonly cell: Cell } | undefined;
  readonly llm: LlmPort | undefined;
  readonly provisioning: ProvisionPort | undefined;
  readonly clock: () => number;
}

/** Pure construction: generation acquisition, not a process cache, owns identity. */
export function catalogDefinitions(ports: ToolPorts): readonly AnyToolDefinition[] {
  return Object.freeze([
    eraseTool(createReadTool(ports)),
    eraseTool(createWriteTool(ports)),
    eraseTool(createEditTool(ports)),
    eraseTool(createLsTool(ports)),
    eraseTool(createFindTool(ports)),
    eraseTool(createGrepTool(ports)),
    eraseTool(createBashTool(ports)),
    eraseTool(createEvalTool(ports.cells?.cell)),
    eraseTool(createMonitorTool(ports.alarms)),
    eraseTool(createSendMessageTool(ports.messages, ports.clock)),
    eraseTool(createProvisionTool(ports.provisioning)),
    eraseTool(createCompletionTool(ports.llm)),
  ]);
}
