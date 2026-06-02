import type { Dispatch, Ingress, Model } from "@openomni/protocol";
import type { ResidentRuntime } from "../../resident/runtime.js";
import type { DispatchHandler } from "../registry.js";
import { DEFAULT_DISPATCH_MODEL } from "../owners.js";

export interface ResidentDispatchHandlerOptions {
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly defaultModel?: Model.Ref;
}

function requireResidentRuntime(
  residentRuntime: Pick<ResidentRuntime, "run"> | undefined,
): Pick<ResidentRuntime, "run"> {
  if (!residentRuntime) throw new Error("dispatch resident handler requires residentRuntime owner");
  return residentRuntime;
}

function eventFromCommand(
  command: Dispatch.Command,
  model: Model.Ref,
): Ingress.ResolvedInboundEvent {
  return {
    id: command.dispatchId,
    surface: "dispatch",
    mode: "internal",
    agentName: command.target.name ?? command.actor.agentName ?? "resident",
    target: {
      kind: "resident",
      ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
    },
    payload: command.payload,
    meta: {
      actor: {
        role: command.actor.kind,
        id: command.actor.actorId,
        sessionId: command.actor.sessionId,
        runId: command.actor.runId,
        agentName: command.actor.agentName,
      },
      target: {
        kind: "resident",
        ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
      },
    },
    agent: { model },
  };
}

export function createResidentDispatchHandlers(
  options: ResidentDispatchHandlerOptions = {},
): Record<"resident.deliver", DispatchHandler> {
  const model = options.defaultModel ?? DEFAULT_DISPATCH_MODEL;
  return {
    async "resident.deliver"(command, context) {
      const residentRuntime = requireResidentRuntime(options.residentRuntime);
      const sessionId = command.target.sessionId ?? command.sessionId ?? context?.sessionId;
      if (!sessionId)
        throw new Error("resident.deliver requires target.sessionId or runtime sessionId");
      const result = await residentRuntime.run({
        sessionId,
        event: eventFromCommand(command, model),
        traceContext: command.traceId ? { traceId: command.traceId, sessionId } : undefined,
        signal: context?.signal,
      });
      return {
        output: { output: result.output, finishReason: result.finishReason, runId: result.runId },
      };
    },
  };
}
