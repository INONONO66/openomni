import type { Tool } from "@openomni/protocol";
import type { DelegationOrigin } from "../../delegation/admission";
import type { DelegationKernel } from "../../delegation/kernel";
import {
  awaitDelegationToolExecutor,
  awaitDelegationToolSpec,
  cancelDelegationToolExecutor,
  cancelDelegationToolSpec,
  delegateToolExecutor,
  delegateToolSpec,
} from "../../delegation/tool";
import type { CuratedMemory } from "../../memory/store";
import type { ArtifactsPort } from "../mutation/artifacts";
import type { ConversePort } from "../mutation/converse";
import { converseCloseTool, converseOpenTool } from "../mutation/converse";
import { writeArtifactTool } from "../mutation/artifacts";
import { memoryTool } from "../mutation/memory";
import { readArtifactTool } from "../query/artifacts";
import type { ApprovalPort } from "../authority/approval";
import { approvalDecideTool, approvalRequestTool, contactPromoteTool, endpointMergeTool } from "../authority/approval";
import type { CatalogEntry } from "./dispatch";
import type { MachineVfs } from "../../machines/vfs";
import { fsListTool, fsReadTool, fsStatTool } from "../query/machine-fs";
import type { LeasePort } from "../mutation/lease";
import { leaseOpenTool } from "../mutation/lease";
import type { LlmPort } from "../execution/llm";
import { llmTool } from "../execution/llm";
import type { MachinesPort } from "../query/machines";
import { machinesTool } from "../query/machines";
import type { ProvisionPort } from "../provision";
import {
  channelDeclareToolExecutor,
  channelDisableToolExecutor,
  channelEnableToolExecutor,
  personDeclareToolExecutor,
  personRemoveToolExecutor,
  provisionStatusToolExecutor,
  secretRotateToolExecutor,
} from "../provision";
import {
  channelDeclareToolSpec,
  channelDisableToolSpec,
  channelEnableToolSpec,
  personDeclareToolSpec,
  personRemoveToolSpec,
  provisionStatusToolSpec,
  secretRotateToolSpec,
} from "../provision-specs";
import type { CellPorts } from "../execution/run-code";
import { runCodeTool } from "../execution/run-code";
import type { CompletionPort } from "../../work-item/completion";
import { completeWorkTool } from "../mutation/work-items";
import { workItemsTool } from "../query/work-items";
import { eraseTool, type AnyToolDefinition } from "./define";
import { toolSpec } from "./project";

export interface CatalogPorts {
  readonly delegation?: DelegationKernel;
  readonly conversations?: ConversePort;
  readonly leases?: LeasePort;
  readonly approvals?: ApprovalPort;
  readonly cells?: CellPorts;
  readonly machines?: MachinesPort;
  /**
   * The read-only machine filesystem as one flat namespace. Separate from
   * `machines` because the two answer different questions — which machines
   * exist, versus what one of them holds — and a host wired without an fs
   * door must offer no fs tool rather than one that always refuses.
   */
  readonly machineFs?: MachineVfs;
  readonly memory?: CuratedMemory;
  readonly workItems?: CompletionPort;
  readonly llm?: LlmPort;
  readonly artifacts?: ArtifactsPort;
  readonly provisioning?: ProvisionPort;
}

type ToolRun = CatalogEntry["run"];

// PHASE-A BRIDGE: dies in phase B
interface LegacyCatalogTool {
  readonly spec: () => Tool.Spec;
  /**
   * The capability gate: a port that is not wired contributes no entry — a
   * capability the app does not have is absent from the catalog rather than
   * present and always refusing.
   */
  readonly wire: (ports: CatalogPorts, origin: DelegationOrigin) => ToolRun | undefined;
}

/**
 * Every tool this app could offer, before placement has an opinion — the one
 * list both the catalog and the repository lint read, so a spec cannot exist
 * here without being wireable, or ship without being linted.
 */
export const TOOL_DEFINITIONS: readonly (AnyToolDefinition | LegacyCatalogTool)[] = [
  {
    spec: delegateToolSpec,
    wire: (ports, origin) =>
      ports.delegation === undefined ? undefined : delegateToolExecutor(ports.delegation, origin),
  },
  {
    spec: awaitDelegationToolSpec,
    wire: (ports) =>
      ports.delegation === undefined ? undefined : awaitDelegationToolExecutor(ports.delegation),
  },
  {
    spec: cancelDelegationToolSpec,
    wire: (ports) =>
      ports.delegation === undefined ? undefined : cancelDelegationToolExecutor(ports.delegation),
  },
  eraseTool(converseOpenTool),
  eraseTool(converseCloseTool),
  eraseTool(leaseOpenTool),
  eraseTool(approvalRequestTool),
  eraseTool(approvalDecideTool),
  eraseTool(contactPromoteTool),
  eraseTool(endpointMergeTool),
  {
    // Provisioning administration is the Resident's surface (provisioning
    // §5, §8.5): a delegated worker never edits Persons, channels, or
    // secrets — the same role gate as the approval lane it consumes.
    spec: personDeclareToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : personDeclareToolExecutor(ports.provisioning),
  },
  {
    spec: personRemoveToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : personRemoveToolExecutor(ports.provisioning),
  },
  {
    spec: channelDeclareToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : channelDeclareToolExecutor(ports.provisioning),
  },
  {
    spec: channelEnableToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : channelEnableToolExecutor(ports.provisioning),
  },
  {
    spec: channelDisableToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : channelDisableToolExecutor(ports.provisioning),
  },
  {
    spec: secretRotateToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : secretRotateToolExecutor(ports.provisioning),
  },
  {
    spec: provisionStatusToolSpec,
    wire: (ports, origin) =>
      ports.provisioning === undefined || origin.role !== "resident"
        ? undefined
        : provisionStatusToolExecutor(ports.provisioning),
  },
  eraseTool(runCodeTool),
  eraseTool(machinesTool),
  eraseTool(fsReadTool),
  eraseTool(fsListTool),
  eraseTool(fsStatTool),
  eraseTool(memoryTool),
  eraseTool(workItemsTool),
  eraseTool(completeWorkTool),
  eraseTool(llmTool),
  eraseTool(writeArtifactTool),
  eraseTool(readArtifactTool),
];

/** Every spec the app can ship, as data — no ports, no origin: the repository lint's seam. */
export function collectToolSpecs(): readonly Tool.Spec[] {
  return TOOL_DEFINITIONS.map((tool) => "spec" in tool ? tool.spec() : toolSpec(tool));
}

/**
 * Every tool this app could offer, before placement has an opinion.
 *
 * Entries are built per originator because a tool is bound to who is running
 * it — the same reason the delegate tool takes an origin.
 */
export function catalogEntries(
  ports: CatalogPorts,
  origin: DelegationOrigin,
): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const tool of TOOL_DEFINITIONS) {
    if ("spec" in tool) {
      const run = tool.wire(ports, origin);
      if (run !== undefined) entries.push({ spec: tool.spec(), run });
      continue;
    }
    const visible = tool.visibility.model.includes(origin.role)
      || tool.visibility.cell.includes(origin.role);
    if (!visible) continue;
    const run = tool.bind(ports, origin);
    if (run !== undefined) entries.push({ spec: toolSpec(tool), definition: tool, run });
  }
  return entries;
}
