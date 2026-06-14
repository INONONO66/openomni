import { Extension, type Policy } from "@openomni/protocol";
import { z } from "zod";
import { AuditManifestSummarySchema } from "./manager-manifest";
import type { ExtensionManifestSummary } from "./manager-manifest";
import type { RuntimeBindingController } from "./runtime-binding";

export type ExtensionAction =
  | "extension.validate"
  | "extension.requestInstall"
  | "extension.approve"
  | "extension.install"
  | "extension.enable";

export type AuditVisibility = "internal" | "llm_reason" | "user_audit";

interface AuditBase {
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly visibility: AuditVisibility;
  readonly timestamp: string;
  readonly sequence: number;
}

export interface AuditActionRequested extends AuditBase {
  readonly type: "action_requested";
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly input?: Record<string, unknown>;
}

export interface AuditPolicyEvaluated extends AuditBase {
  readonly type: "policy_evaluated";
  readonly policyId: string;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
}

export interface AuditActionApproved extends AuditBase {
  readonly type: "action_approved";
  readonly policyId: string;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly verdict: "allow";
  readonly reason: string;
}

export interface AuditActionBlocked extends AuditBase {
  readonly type: "action_blocked";
  readonly policyId: string;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
}

export interface AuditBusEvent extends AuditBase {
  readonly type: "bus_event";
  readonly name: string;
  readonly payload: unknown;
}

export type AuditEvent =
  | AuditActionRequested
  | AuditPolicyEvaluated
  | AuditActionApproved
  | AuditActionBlocked
  | AuditBusEvent;

export type LifecycleEventName =
  | "extension.proposed"
  | "extension.approved"
  | "extension.installed"
  | "extension.enabled"
  | "extension.disabled"
  | "extension.rolled_back"
  | "extension.failed";

export interface AuditState {
  readonly sessionId: string;
  readonly actor: Record<string, unknown>;
  readonly action: ExtensionAction;
  readonly resource: string;
  readonly input: Record<string, unknown>;
  readonly parentActionId?: string;
  readonly now: () => Date;
}

export interface ReconstructedState {
  readonly current: Map<string, ExtensionManagerEntry>;
  readonly versions: Map<string, ExtensionManagerEntry>;
}

export interface ExtensionAuditContext {
  readonly sessionId: string;
}

export interface ExtensionOperationOptions {
  readonly actor: Record<string, unknown>;
  readonly audit: ExtensionAuditContext;
  readonly permission?: Policy.Permission;
  readonly now?: () => Date;
}

export interface ExtensionRequestInstallOptions extends ExtensionOperationOptions {
  readonly reason?: string;
}

export interface ExtensionVersionOperationOptions extends ExtensionOperationOptions {
  readonly version?: string;
  readonly reason?: string;
}

export interface ExtensionBindingOperationOptions extends ExtensionVersionOperationOptions {
  readonly binding?: RuntimeBindingController;
}

export interface ExtensionManagerEntry {
  readonly id: string;
  readonly version: string;
  readonly state: Extension.LifecycleState;
  readonly actor: string;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly fromVersion?: string;
  readonly manifest?: ExtensionManifestSummary;
  readonly error?: string;
}

export const AUDIT_VISIBILITY: AuditVisibility = "internal";
export const AUTHORITY_REQUIRED_REASON =
  "extension_authority_requires_user_main_or_trusted_manager";
export const authorityActorKinds: readonly string[] = ["user", "main", "trusted_manager"];
export const authorityActions = new Set<ExtensionAction>(["extension.approve", "extension.enable"]);
export const lifecycleNames = new Set<LifecycleEventName>([
  "extension.proposed",
  "extension.approved",
  "extension.installed",
  "extension.enabled",
  "extension.disabled",
  "extension.rolled_back",
  "extension.failed",
]);

export const LifecyclePayloadSchema = z.object({
  extensionId: z.string(),
  version: z.string(),
  actor: z.string(),
  time: z.number(),
  reason: z.string().optional(),
  state: Extension.LifecycleState,
  fromVersion: z.string().optional(),
  manifest: AuditManifestSummarySchema.optional(),
  error: z.string().optional(),
});

export type LifecyclePayload = z.infer<typeof LifecyclePayloadSchema>;
