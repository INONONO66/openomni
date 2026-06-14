import { actorLabel, truncateAuditText } from "./audit-util";
import { approveOperation, beginOperation, blockOperation, operationInput } from "./manager-audit";
import {
  auditManifestSummary,
  auditValidationInput,
  auditValidationResource,
  parseExtensionManifest,
} from "./manager-manifest";
import type { ExtensionValidationResult } from "./manager-manifest";
import {
  appendLifecycleEvent,
  reconstructState,
  resolveEntry,
  resolveRollbackTarget,
  sortEntries,
  stateKey,
} from "./manager-state";
import { transition } from "./manager-transition";
import type {
  ExtensionAuditEntry,
  ExtensionAuditOptions,
  ExtensionBindingOperationOptions,
  ExtensionListOptions,
  ExtensionManagerEntry,
  ExtensionOperationOptions,
  ExtensionRequestInstallOptions,
  ExtensionRollbackOptions,
  ExtensionVersionOperationOptions,
} from "./manager-types";

export type {
  ExtensionManifestSummary,
  ExtensionValidationFailure,
  ExtensionValidationResult,
  ExtensionValidationSuccess,
} from "./manager-manifest";

export type {
  ExtensionAuditContext,
  ExtensionAuditEntry,
  ExtensionAuditOptions,
  ExtensionBindingOperationOptions,
  ExtensionLifecycleAuditEntry,
  ExtensionListOptions,
  ExtensionManagerEntry,
  ExtensionOperationAuditEntry,
  ExtensionOperationOptions,
  ExtensionRequestInstallOptions,
  ExtensionRollbackOptions,
  ExtensionVersionOperationOptions,
} from "./manager-types";

export namespace ExtensionManager {
  export async function validate(
    manifest: unknown,
    options: ExtensionOperationOptions,
  ): Promise<ExtensionValidationResult> {
    const operation = await beginOperation(options, {
      action: "extension.validate",
      resource: auditValidationResource(manifest),
      input: auditValidationInput(manifest),
    });
    const result = parseExtensionManifest(manifest);

    await approveOperation(
      operation,
      result.success
        ? "extension manifest validation passed"
        : "extension manifest validation failed",
    );
    return result;
  }

  export async function requestInstall(
    manifest: unknown,
    options: ExtensionRequestInstallOptions,
  ): Promise<ExtensionManagerEntry> {
    const parsed = parseExtensionManifest(manifest);
    if (!parsed.success) {
      throw new Error(`Invalid extension manifest: ${parsed.errors.join("; ")}`);
    }

    const input = operationInput({
      id: parsed.manifest.id,
      version: parsed.manifest.version,
      reason: options.reason,
      manifest: auditManifestSummary(parsed.manifest),
    });
    const operation = await beginOperation(options, {
      action: "extension.requestInstall",
      resource: parsed.manifest.id,
      input,
    });
    const state = await reconstructState(operation.sessionId);
    const existing = state.versions.get(stateKey(parsed.manifest.id, parsed.manifest.version));
    if (existing && existing.state !== "failed" && existing.state !== "rolled_back") {
      await blockOperation(
        operation,
        "extension.manager.lifecycle",
        "extension_version_already_requested",
      );
      throw new Error(
        `Extension "${parsed.manifest.id}" version "${parsed.manifest.version}" is already ${existing.state}`,
      );
    }

    await approveOperation(operation, "extension install request approved");
    return appendLifecycleEvent(operation, "extension.proposed", {
      extensionId: parsed.manifest.id,
      version: parsed.manifest.version,
      actor: actorLabel(options.actor),
      time: operation.now().getTime(),
      state: "proposed",
      ...(options.reason !== undefined ? { reason: truncateAuditText(options.reason) } : {}),
      manifest: auditManifestSummary(parsed.manifest, { includeComponents: true }),
    });
  }

  export async function approve(
    extensionId: string,
    options: ExtensionVersionOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.approve",
      eventName: "extension.approved",
      nextState: "approved",
      allowedStates: ["proposed"],
      approvalReason: "extension approval accepted",
    });
  }

  export async function install(
    extensionId: string,
    options: ExtensionVersionOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.install",
      eventName: "extension.installed",
      nextState: "installed",
      allowedStates: ["approved"],
      approvalReason: "extension install accepted",
    });
  }

  export async function enable(
    extensionId: string,
    options: ExtensionBindingOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.enable",
      eventName: "extension.enabled",
      nextState: "enabled",
      allowedStates: ["installed", "disabled"],
      approvalReason: "extension enable accepted",
      binding: options.binding,
      bindingAction: "enable",
    });
  }

  export async function disable(
    extensionId: string,
    options: ExtensionBindingOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.disable",
      eventName: "extension.disabled",
      nextState: "disabled",
      allowedStates: ["enabled"],
      approvalReason: "extension disable accepted",
      binding: options.binding,
      bindingAction: "disable",
    });
  }

  export async function rollback(
    extensionId: string,
    options: ExtensionRollbackOptions,
  ): Promise<ExtensionManagerEntry> {
    const input = operationInput({
      id: extensionId,
      version: options.version,
      toVersion: options.toVersion,
      reason: options.reason,
    });
    const operation = await beginOperation(options, {
      action: "extension.rollback",
      resource: extensionId,
      input,
    });
    const state = await reconstructState(operation.sessionId);
    const source = resolveEntry(state, extensionId, options.version, [
      "installed",
      "enabled",
      "disabled",
    ]);
    if (!source) {
      await blockOperation(operation, "extension.manager.lifecycle", "extension_not_rollbackable");
      throw new Error(
        `Extension "${extensionId}" has no installed, enabled, or disabled version to roll back`,
      );
    }

    const targetVersion = resolveRollbackTarget(
      state,
      extensionId,
      source.version,
      options.toVersion,
    );
    if (!targetVersion) {
      await blockOperation(
        operation,
        "extension.manager.lifecycle",
        "extension_previous_version_missing",
      );
      throw new Error(`Extension "${extensionId}" has no previous version to roll back to`);
    }

    await approveOperation(operation, "extension rollback accepted");
    return appendLifecycleEvent(operation, "extension.rolled_back", {
      extensionId,
      version: targetVersion,
      actor: actorLabel(options.actor),
      time: operation.now().getTime(),
      state: "rolled_back",
      fromVersion: source.version,
      ...(options.reason !== undefined ? { reason: truncateAuditText(options.reason) } : {}),
      manifest: state.versions.get(stateKey(extensionId, targetVersion))?.manifest,
    });
  }

  export async function list(options: ExtensionListOptions): Promise<ExtensionManagerEntry[]> {
    const resource = options.extensionId ?? "all";
    const operation = await beginOperation(options, {
      action: "extension.list",
      resource,
      input: operationInput({ id: options.extensionId }),
    });
    const state = await reconstructState(operation.sessionId);
    const entries = sortEntries([...state.current.values()]).filter(
      (entry) => options.extensionId === undefined || entry.id === options.extensionId,
    );

    await approveOperation(operation, "extension list accepted");
    return entries;
  }

  export async function audit(options: ExtensionAuditOptions): Promise<ExtensionAuditEntry[]> {
    const resource = options.extensionId ?? "all";
    const operation = await beginOperation(options, {
      action: "extension.audit",
      resource,
      input: operationInput({ id: options.extensionId }),
    });
    const state = await reconstructState(operation.sessionId);
    const entries = state.audit.filter(
      (entry) =>
        options.extensionId === undefined ||
        (entry.kind === "lifecycle"
          ? entry.extensionId === options.extensionId
          : entry.resource === options.extensionId),
    );

    await approveOperation(operation, "extension audit accepted");
    return entries;
  }
}
