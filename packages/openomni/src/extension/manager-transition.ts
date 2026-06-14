import type { Extension } from "@openomni/protocol";
import { actorLabel, errorMessage, truncateAuditText } from "./audit-util";
import { approveOperation, beginOperation, blockOperation, operationInput } from "./manager-audit";
import { appendLifecycleEvent, reconstructState, resolveEntry } from "./manager-state";
import type {
  ExtensionAction,
  ExtensionManagerEntry,
  ExtensionVersionOperationOptions,
  LifecycleEventName,
  LifecyclePayload,
} from "./manager-types";
import type { RuntimeBindingController, RuntimeBindingExtension } from "./runtime-binding";

interface TransitionConfig {
  readonly action: Extract<
    ExtensionAction,
    "extension.approve" | "extension.install" | "extension.enable" | "extension.disable"
  >;
  readonly eventName: LifecycleEventName;
  readonly nextState: Extension.LifecycleState;
  readonly allowedStates: readonly Extension.LifecycleState[];
  readonly approvalReason: string;
  readonly binding?: RuntimeBindingController;
  readonly bindingAction?: "enable" | "disable";
}

export async function transition(
  extensionId: string,
  options: ExtensionVersionOperationOptions,
  config: TransitionConfig,
): Promise<ExtensionManagerEntry> {
  const operation = await beginOperation(options, {
    action: config.action,
    resource: extensionId,
    input: operationInput({ id: extensionId, version: options.version, reason: options.reason }),
  });
  const state = await reconstructState(operation.sessionId);
  const current = resolveEntry(state, extensionId, options.version, config.allowedStates);
  if (!current) {
    await blockOperation(operation, "extension.manager.lifecycle", "invalid_lifecycle_transition");
    throw new Error(
      `Extension "${extensionId}"${options.version ? ` version "${options.version}"` : ""} cannot ${config.action.replace("extension.", "")} from its current state`,
    );
  }

  await approveOperation(operation, config.approvalReason);
  const payload: LifecyclePayload = {
    extensionId,
    version: current.version,
    actor: actorLabel(options.actor),
    time: operation.now().getTime(),
    state: config.nextState,
    ...(options.reason !== undefined ? { reason: truncateAuditText(options.reason) } : {}),
    ...(current.manifest !== undefined ? { manifest: current.manifest } : {}),
  };

  if (config.binding && config.bindingAction) {
    try {
      await runBinding(config.binding, config.bindingAction, current);
    } catch (error) {
      await appendLifecycleEvent(operation, "extension.failed", {
        extensionId,
        version: current.version,
        actor: actorLabel(options.actor),
        time: operation.now().getTime(),
        state: "failed",
        reason: "runtime_binding_failed",
        error: truncateAuditText(errorMessage(error)),
        ...(current.manifest !== undefined ? { manifest: current.manifest } : {}),
      });
      throw new Error(`Extension runtime binding failed: ${errorMessage(error)}`);
    }
  }

  return appendLifecycleEvent(operation, config.eventName, payload);
}

async function runBinding(
  binding: RuntimeBindingController,
  action: "enable" | "disable",
  entry: ExtensionManagerEntry,
): Promise<void> {
  const extension: RuntimeBindingExtension = {
    id: entry.id,
    version: entry.version,
    ...(entry.manifest?.components !== undefined ? { contributes: entry.manifest.components } : {}),
  };

  if (action === "enable") {
    await binding.enable(extension);
    return;
  }

  await binding.disable(extension);
}
