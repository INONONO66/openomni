import { Dispatch, Execution } from "@openomni/protocol";
import { digestEffectValue } from "../../execution-runtime/effect-scope.js";
import type { ToolEffectLedgerPortV1 } from "../../execution-runtime/tool/types.js";
import {
  createWorkspaceIdentity,
  toWorkspaceRef,
} from "../../execution-runtime/workspace-identity.js";
import type { DeviceDispatchOwner } from "../owners.js";
import type { DispatchHandler, DispatchHandlerContext } from "../registry.js";

export interface DeviceDispatchHandlerOptions {
  readonly device?: DeviceDispatchOwner;
  readonly effects: ToolEffectLedgerPortV1;
}

function requireDevice(device: DeviceDispatchOwner | undefined): DeviceDispatchOwner {
  if (!device) throw new Error("dispatch device handler requires device owner");
  return device;
}

function requireDeviceId(command: Dispatch.Command): string {
  if (command.target.kind !== "system") {
    throw new Error("device.command requires system target");
  }
  const deviceId = command.target.id ?? command.target.name;
  if (!deviceId) throw new Error("device.command requires target.id or target.name");
  return deviceId;
}

function canonicalEffectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEffectValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalEffectValue(nested)]),
    );
  }
  return value;
}

function requireAcceptedEffectReceipt(
  receipt: Awaited<ReturnType<ToolEffectLedgerPortV1["appendIntent"]>>,
): void {
  if (receipt.version === "tool-effect-append-receipt-v1" && receipt.status === "accepted") return;
  throw new Error(
    `effect ledger denied: ${receipt.status}${receipt.reason ? ` (${receipt.reason})` : ""}`,
  );
}

function deviceEffectIntent(
  command: Dispatch.Command,
  deviceId: string,
  workspaceRoot: string | undefined,
) {
  if (!workspaceRoot) throw new Error("device.command requires workspaceRoot effect scope");
  const workspace = createWorkspaceIdentity(workspaceRoot);
  const inputDigest = digestEffectValue(
    JSON.stringify(canonicalEffectValue({ deviceId, payload: command.payload })),
  );
  const scope = Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(workspace),
    resources: [
      {
        version: "resource-scope-v1",
        kind: "device",
        driver: "device.submit.v1",
        target: deviceId,
      },
    ],
    resolver: { id: "device-target-v1", version: "1", inputDigest },
    containment: "none",
    mutationClass: "unknown",
  });
  const sourceRef = digestEffectValue(
    JSON.stringify({
      version: "tool-effect-source-v1",
      sessionId: command.sessionId ?? command.actor.sessionId ?? null,
      runId: command.runId ?? null,
      toolCallId: command.dispatchId,
      operation: command.action,
      operationVersion: "1",
      scope,
    }),
  );
  return Object.freeze({
    version: "tool-effect-intent-v1" as const,
    effectId: `dispatch-effect:${sourceRef}`,
    sourceRef,
    toolCallId: command.dispatchId,
    operation: command.action,
    operationVersion: "1" as const,
    scope,
  });
}

async function settleDeviceEffect(
  effects: ToolEffectLedgerPortV1,
  intent: ReturnType<typeof deviceEffectIntent>,
  status: "confirmed" | "unknown",
): Promise<void> {
  requireAcceptedEffectReceipt(
    await effects.appendSettlement({
      version: "tool-effect-settlement-v1",
      effectId: intent.effectId,
      sourceRef: intent.sourceRef,
      status,
    }),
  );
}

async function dispatchDeviceCommand(
  options: DeviceDispatchHandlerOptions,
  command: Dispatch.Command,
  context: DispatchHandlerContext | undefined,
): Promise<{ readonly output: unknown }> {
  const deviceId = requireDeviceId(command);
  const intent = deviceEffectIntent(command, deviceId, context?.workspaceRoot);
  requireAcceptedEffectReceipt(await options.effects.appendIntent(intent));
  let output: unknown;
  try {
    output = await requireDevice(options.device).dispatch({
      command,
      deviceId,
      payload: command.payload,
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.wait !== undefined ? { wait: context.wait } : {}),
      ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    });
  } catch (error) {
    await settleDeviceEffect(options.effects, intent, "unknown");
    throw error;
  }
  await settleDeviceEffect(options.effects, intent, "confirmed");
  return { output };
}

export function createDeviceDispatchHandlers(
  options: DeviceDispatchHandlerOptions,
): Record<typeof Dispatch.Actions.DeviceCommand, DispatchHandler> {
  return {
    [Dispatch.Actions.DeviceCommand]: (command, context) =>
      dispatchDeviceCommand(options, command, context),
  };
}
