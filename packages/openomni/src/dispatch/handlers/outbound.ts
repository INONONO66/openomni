import { Dispatch, Execution } from "@openomni/protocol";
import {
  createWorkspaceIdentity,
  toWorkspaceRef,
} from "../../execution-runtime/workspace-identity.js";
import { digestEffectValue } from "../../execution-runtime/effect-scope.js";
import type { ToolEffectLedgerPortV1 } from "../../execution-runtime/tool/types.js";
import type { OutboundDispatchOwner } from "../owners.js";
import type { DispatchHandler, DispatchHandlerContext } from "../registry.js";

export interface OutboundDispatchHandlerOptions {
  readonly outbound?: OutboundDispatchOwner;
  readonly effects: ToolEffectLedgerPortV1;
}

type OutboundAction =
  | typeof Dispatch.Actions.ExternalAsk
  | typeof Dispatch.Actions.A2aAsk
  | typeof Dispatch.Actions.ApiAsk;

function requireOutbound(outbound: OutboundDispatchOwner | undefined): OutboundDispatchOwner {
  if (!outbound) throw new Error("dispatch outbound handler requires outbound owner");
  return outbound;
}

function requireExternalEndpoint(command: Dispatch.Command, action: string): string {
  if (command.target.kind !== "external_actor") {
    throw new Error(`${action} requires external_actor target`);
  }
  const endpointId = command.target.id ?? command.target.name;
  if (!endpointId) throw new Error(`${action} requires target.id or target.name`);
  return endpointId;
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

function outboundEffectIntent(
  command: Dispatch.Command,
  endpointId: string,
  workspaceRoot: string | undefined,
) {
  if (!workspaceRoot) throw new Error(`${command.action} requires workspaceRoot effect scope`);
  const workspace = createWorkspaceIdentity(workspaceRoot);
  const inputDigest = digestEffectValue(
    JSON.stringify(canonicalEffectValue({ endpointId, payload: command.payload })),
  );
  const scope = Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: toWorkspaceRef(workspace),
    resources: [
      {
        version: "resource-scope-v1",
        kind: "endpoint",
        targetDigest: digestEffectValue(endpointId),
      },
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: "outbound.v1",
        targetDigest: digestEffectValue(command.action),
      },
    ],
    resolver: { id: "outbound-endpoint-v1", version: "1", inputDigest },
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

async function settleOutboundEffect(
  effects: ToolEffectLedgerPortV1,
  intent: ReturnType<typeof outboundEffectIntent>,
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

async function dispatchOutbound(
  options: OutboundDispatchHandlerOptions,
  command: Dispatch.Command,
  context: DispatchHandlerContext | undefined,
): Promise<{ readonly output: unknown }> {
  const endpointId = requireExternalEndpoint(command, command.action);
  const intent = outboundEffectIntent(command, endpointId, context?.workspaceRoot);
  requireAcceptedEffectReceipt(await options.effects.appendIntent(intent));
  let output: unknown;
  try {
    output = await requireOutbound(options.outbound).dispatch({
      command,
      endpointId,
      payload: command.payload,
      ...(command.correlation ? { correlation: command.correlation } : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
      ...(context?.wait !== undefined ? { wait: context.wait } : {}),
      ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    });
  } catch (error) {
    await settleOutboundEffect(options.effects, intent, "unknown");
    throw error;
  }
  await settleOutboundEffect(options.effects, intent, "confirmed");
  return { output };
}

export function createOutboundDispatchHandlers(
  options: OutboundDispatchHandlerOptions,
): Record<OutboundAction, DispatchHandler> {
  const handler: DispatchHandler = (command, context) =>
    dispatchOutbound(options, command, context);
  return {
    [Dispatch.Actions.ExternalAsk]: handler,
    [Dispatch.Actions.A2aAsk]: handler,
    [Dispatch.Actions.ApiAsk]: handler,
  };
}
