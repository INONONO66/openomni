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
import type { ApprovalPort } from "../approval";
import {
  approvalDecideToolExecutor,
  approvalDecideToolSpec,
  approvalRequestToolExecutor,
  approvalRequestToolSpec,
  contactPromoteToolExecutor,
  contactPromoteToolSpec,
  endpointMergeToolExecutor,
  endpointMergeToolSpec,
} from "../approval";
import type { CatalogEntry } from "./dispatch";
import type { MachineVfs } from "../../machines/vfs";
import { fsListTool, fsReadTool, fsStatTool } from "../query/machine-fs";
import type { LeasePort } from "../lease";
import { leaseOpenToolExecutor, leaseOpenToolSpec } from "../lease";
import type { LlmPort } from "../llm";
import { llmToolExecutor, llmToolSpec } from "../llm";
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
import type { CellPorts } from "../run-code";
import { runCodeToolExecutor, runCodeToolSpec } from "../run-code";
import type { CompletionPort } from "../../work-item/completion";
import {
  completeWorkToolExecutor,
  completeWorkToolSpec,
  workItemsToolExecutor,
  workItemsToolSpec,
} from "../work-items";
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
  {
    // Lease issuance is the Resident's judgment alone (§3.5): a worker
    // never widens its own authority.
    spec: leaseOpenToolSpec,
    wire: (ports, origin) =>
      ports.leases === undefined || origin.role !== "resident"
        ? undefined
        : leaseOpenToolExecutor(ports.leases),
  },
  {
    // The approval lane is the Resident's surface (§6): a worker never
    // requests, records, or consumes Owner consent.
    spec: approvalRequestToolSpec,
    wire: (ports, origin) =>
      ports.approvals === undefined || origin.role !== "resident"
        ? undefined
        : approvalRequestToolExecutor(ports.approvals),
  },
  {
    spec: approvalDecideToolSpec,
    wire: (ports, origin) =>
      ports.approvals === undefined || origin.role !== "resident"
        ? undefined
        : approvalDecideToolExecutor(ports.approvals),
  },
  {
    spec: contactPromoteToolSpec,
    wire: (ports, origin) =>
      ports.approvals === undefined || origin.role !== "resident"
        ? undefined
        : contactPromoteToolExecutor(ports.approvals),
  },
  {
    spec: endpointMergeToolSpec,
    wire: (ports, origin) =>
      ports.approvals === undefined || origin.role !== "resident"
        ? undefined
        : endpointMergeToolExecutor(ports.approvals),
  },
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
  {
    spec: runCodeToolSpec,
    wire: (ports, origin) =>
      ports.cells === undefined ? undefined : runCodeToolExecutor(ports.cells, origin),
  },
  eraseTool(machinesTool),
  eraseTool(fsReadTool),
  eraseTool(fsListTool),
  eraseTool(fsStatTool),
  eraseTool(memoryTool),
  {
    // Completion authority is the Resident's alone (kernel-contract
    // completion law): a worker never judges its own work, so the surface is
    // role-gated exactly like memory.
    spec: workItemsToolSpec,
    wire: (ports, origin) =>
      ports.workItems === undefined || origin.role !== "resident"
        ? undefined
        : workItemsToolExecutor(ports.workItems),
  },
  {
    spec: completeWorkToolSpec,
    wire: (ports, origin) =>
      ports.workItems === undefined || origin.role !== "resident"
        ? undefined
        : completeWorkToolExecutor(ports.workItems),
  },
  {
    spec: llmToolSpec,
    wire: (ports) => (ports.llm === undefined ? undefined : llmToolExecutor(ports.llm)),
  },
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
