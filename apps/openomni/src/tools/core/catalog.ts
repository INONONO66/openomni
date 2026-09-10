import { eraseTool, toolSpec } from "@openomni/agent";
import type { GatewayRouter } from "@openomni/channels";
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
import { createSendMessageTool } from "../send-message";
import { createWriteTool } from "../write";

export interface CatalogOrigin {
  readonly role: LedgerSession.Role;
  readonly sessionId: string;
}

export interface CatalogPorts {
  readonly messages?: Pick<GatewayRouter, "ingest">;
  readonly machines?: MachineHost;
  readonly cells?: Pick<ReturnType<typeof composeCodemode>, "cell" | "bindTools">;
  readonly llm?: LlmPort;
  readonly provisioning?: ProvisionPort;
  /** The session runtime clock; deadlines are computed against it, never wall time. */
  readonly clock?: () => number;
}

const catalogs = new WeakMap<
  CatalogPorts,
  Readonly<Record<LedgerSession.Role, readonly AnyToolDefinition[]>>
>();

/** Immutable ports own one catalog; session composition owns cell binding. */
export function createTools(
  ports: CatalogPorts,
  origin: CatalogOrigin,
): readonly AnyToolDefinition[] {
  const cached = catalogs.get(ports);
  if (cached !== undefined) return cached[origin.role];
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
  const visible = (role: LedgerSession.Role) =>
    tools.filter(
      (tool) => tool.visibility.model.includes(role) || tool.visibility.cell.includes(role),
    );
  const catalog = { resident: visible("resident"), worker: visible("worker") };
  catalogs.set(ports, catalog);
  return catalog[origin.role];
}

/** Schema-only exhaustive list used by repository conformance tooling. */
export const TOOL_DEFINITIONS: readonly AnyToolDefinition[] = createTools(
  {},
  { role: "resident", sessionId: "catalog" },
);

export function collectToolSpecs(): readonly Tool.Spec[] {
  return TOOL_DEFINITIONS.map(toolSpec);
}
