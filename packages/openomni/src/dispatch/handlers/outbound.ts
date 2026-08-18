import { Command } from "@openomni/protocol";
import type { OutboundDispatchOwner } from "../owners.js";
import type { DispatchHandler, DispatchHandlerContext } from "../registry.js";

export interface OutboundDispatchHandlerOptions {
  readonly outbound?: OutboundDispatchOwner;
}

type OutboundAction =
  | typeof Command.Actions.ExternalAsk
  | typeof Command.Actions.A2aAsk
  | typeof Command.Actions.ApiAsk;

function requireOutbound(outbound: OutboundDispatchOwner | undefined): OutboundDispatchOwner {
  if (!outbound) throw new Error("dispatch outbound handler requires outbound owner");
  return outbound;
}

function requireExternalEndpoint(command: Command.Request, action: string): string {
  if (command.target.kind !== "external_actor") {
    throw new Error(`${action} requires external_actor target`);
  }
  const endpointId = command.target.id ?? command.target.name;
  if (!endpointId) throw new Error(`${action} requires target.id or target.name`);
  return endpointId;
}

async function dispatchOutbound(
  outbound: OutboundDispatchOwner,
  command: Command.Request,
  context: DispatchHandlerContext | undefined,
): Promise<{ readonly output: unknown }> {
  const output = await outbound.dispatch({
    command,
    endpointId: requireExternalEndpoint(command, command.action),
    payload: command.payload,
    ...(command.correlation ? { correlation: command.correlation } : {}),
    ...(context?.signal ? { signal: context.signal } : {}),
    ...(context?.wait !== undefined ? { wait: context.wait } : {}),
    ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
  });
  return { output };
}

export function createOutboundDispatchHandlers(
  options: OutboundDispatchHandlerOptions = {},
): Record<OutboundAction, DispatchHandler> {
  const handler: DispatchHandler = (command, context) =>
    dispatchOutbound(requireOutbound(options.outbound), command, context);
  return {
    [Command.Actions.ExternalAsk]: handler,
    [Command.Actions.A2aAsk]: handler,
    [Command.Actions.ApiAsk]: handler,
  };
}
