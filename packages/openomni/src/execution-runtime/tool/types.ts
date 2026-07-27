import type { Execution, Policy, RuntimeResource, Tool, ToolSelection } from "@openomni/protocol";
import type { WorkspaceIdentity } from "../workspace-identity.js";

export type ToolCategory = "system" | "agent" | "mcp";
export type ToolMetaValue = boolean | ((input: unknown) => boolean);
export type ToolSource = Tool.Source;
export type ToolRiskTier = Tool.RiskTier;
// Tier 0: read-only (read, glob, grep.search)
// Tier 1: local write (write, edit)
// Tier 2: bash — logged, future approval gate
// Tier 3: reserved

export type ImplicitInputSource = "sessionId" | "runId" | "agentName" | "workspaceRoot";

export interface ToolRuntimeContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
}

export type ToolExecutionContext = Tool.ExecutionContext;

declare const acceptedToolEffect: unique symbol;
/** Executor-minted proof that the durable pre-act effect intent was accepted. */
export type AcceptedToolEffectContext = ToolExecutionContext & {
  readonly [acceptedToolEffect]: true;
};

export interface NativeTool {
  spec: Tool.Spec;
  riskTier: ToolRiskTier;
  isReadOnly: ToolMetaValue;
  isDestructive: ToolMetaValue;
  isConcurrencySafe: ToolMetaValue;
  labels?: readonly string[];
  descriptor?: RuntimeResource.Descriptor;
  source?: ToolSource;
  category?: ToolSelection.Category;
  implicitInputs?: Readonly<Record<string, ImplicitInputSource>>;
  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result>;
}

export interface ToolProvider {
  readonly name: string;
  readonly category: ToolCategory;
  listTools(): NativeTool[];
  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result>;
}

export type ToolEffectIntentV1 = Readonly<{
  version: "tool-effect-intent-v1";
  effectId: string;
  sourceRef: string;
  toolCallId: string;
  operation: string;
  operationVersion: "1";
  scope: Execution.EffectScopeV1;
  execution?: Readonly<{
    sessionId: string;
    runId: string;
  }>;
}>;

export type ToolEffectSettlementStatus = "confirmed" | "failed" | "unknown";

export type ToolEffectSettlementV1 = Readonly<{
  version: "tool-effect-settlement-v1";
  effectId: string;
  sourceRef: string;
  status: ToolEffectSettlementStatus;
}>;

export type ToolEffectAppendReceiptV1 = Readonly<{
  version: "tool-effect-append-receipt-v1";
  status: "accepted" | "rejected" | "pending" | "unknown";
  receiptId?: string;
  reason?: string;
}>;

/** Composition-provisioned semantic effect ledger face; it exposes no writer or query authority. */
export interface ToolEffectLedgerPortV1 {
  appendIntent(intent: ToolEffectIntentV1): Promise<ToolEffectAppendReceiptV1>;
  appendSettlement(settlement: ToolEffectSettlementV1): Promise<ToolEffectAppendReceiptV1>;
}

export interface ToolExecutorConfig {
  permissions?: Policy.Permission;
  workspaceRoot?: string;
  runtime?: ToolRuntimeContext;
  workspaceIdentity?: WorkspaceIdentity;
  effects?: ToolEffectLedgerPortV1;
  timeoutMs?: {
    tier0?: number;
    tier1?: number;
    tier2?: number;
  };
}
