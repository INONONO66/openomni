import type { Dispatch, Ingress, Model } from "@openomni/protocol";
import { PendingAskStore } from "@openomni/session";
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
    agentName: "resident",
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

function originActorKind(actor: Dispatch.ActorContext): "resident" | "worker" | "system" {
  if (actor.kind === "resident" || actor.kind === "worker") return actor.kind;
  return "system";
}

function openPendingAsk(command: Dispatch.Command, fallbackSessionId: string): void {
  PendingAskStore.create({
    id: command.dispatchId,
    originSessionId: command.actor.sessionId ?? command.sessionId ?? fallbackSessionId,
    ...((command.actor.runId ?? command.runId)
      ? { originRunId: command.actor.runId ?? command.runId }
      : {}),
    originActorKind: originActorKind(command.actor),
    targetKind: "resident",
    ...(command.target.id ? { targetActorId: command.target.id } : {}),
    correlation: command.correlation ? { tokenHash: command.correlation } : {},
  });
}

export function createResidentDispatchHandlers(
  options: ResidentDispatchHandlerOptions = {},
): Record<"resident.ask", DispatchHandler> {
  const model = options.defaultModel ?? DEFAULT_DISPATCH_MODEL;
  return {
    async "resident.ask"(command, context) {
      const residentRuntime = requireResidentRuntime(options.residentRuntime);
      if (command.target.kind !== "resident") {
        throw new Error("resident.ask requires resident target");
      }
      const sessionId = command.target.sessionId ?? command.sessionId ?? context?.sessionId;
      if (!sessionId)
        throw new Error("resident.ask requires target.sessionId or runtime sessionId");
      openPendingAsk(command, sessionId);
      try {
        const result = await residentRuntime.run({
          sessionId,
          event: eventFromCommand(command, model),
          traceContext: command.traceId ? { traceId: command.traceId, sessionId } : undefined,
          signal: context?.signal,
        });
        PendingAskStore.answer(command.dispatchId);
        return {
          output: { output: result.output, finishReason: result.finishReason, runId: result.runId },
        };
      } catch (error) {
        PendingAskStore.expire(command.dispatchId);
        throw error;
      }
    },
  };
}
