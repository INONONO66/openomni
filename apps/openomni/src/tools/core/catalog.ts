import { eraseTool, toolSpec } from "@openomni/agent";
import type { MachineHost } from "@openomni/machines";
import type { AnyToolDefinition, LedgerSession, Tool } from "@openomni/protocol";
import type { composeCodemode } from "../../composition/codemode";
import { createBashTool } from "../bash";
import { createCompletionTool, type LlmPort } from "../completion";
import { createEditTool } from "../edit";
import { createEvalTool } from "../eval";
import { createFindTool } from "../find";
import { createGrepTool } from "../grep";
import { createLsTool } from "../ls";
import { monitorTool } from "../monitor";
import { createProvisionTool, type ProvisionPort } from "../provision";
import { createReadTool } from "../read";
import { createSendMessageTool, type MessagePort } from "../send-message";
import { createWriteTool } from "../write";

export interface CatalogOrigin {
  readonly role: LedgerSession.Role;
  readonly depth: number;
  readonly sessionId: string;
}

export interface CatalogPorts {
  readonly messages?: MessagePort;
  readonly machines?: MachineHost;
  readonly cells?: Pick<ReturnType<typeof composeCodemode>, "cell" | "bindTools">;
  readonly llm?: LlmPort;
  readonly provisioning?: ProvisionPort;
  /** The session runtime clock; deadlines are computed against it, never wall time. */
  readonly clock?: () => number;
}

/** The sealed catalog (KERNEL §3.4): the eleven model-door tools, in this order. */
export const MODEL_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
  "bash",
  "eval",
  "monitor",
  "send_message",
  "provision",
] as const;
/** The one cell-only tool. */
export const CELL_TOOL_NAMES = ["completion"] as const;

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
    eraseTool(createLsTool(ports)),
    eraseTool(createFindTool(ports)),
    eraseTool(createGrepTool(ports)),
    eraseTool(createBashTool(ports)),
    eraseTool(createEvalTool(ports.cells?.cell)),
    eraseTool(monitorTool),
    eraseTool(createSendMessageTool(ports.messages, ports.clock)),
    eraseTool(createProvisionTool(ports.provisioning)),
    eraseTool(createCompletionTool(ports.llm)),
  ];
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
