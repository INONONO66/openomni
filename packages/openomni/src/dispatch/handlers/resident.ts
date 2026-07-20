import type { Dispatch, Ingress, Model } from "@openomni/protocol";
import { PendingAskStore } from "@openomni/session";
import type { ResidentRuntime } from "../../resident/runtime.js";
import { type AgentResolver, IngressEngine } from "../../ingress/engine.js";
import type { DispatchHandler } from "../registry.js";

export interface ResidentDispatchHandlerOptions {
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly defaultModel?: Model.Ref;
  readonly agentResolver?: AgentResolver;
}

function requireResidentRuntime(
  residentRuntime: Pick<ResidentRuntime, "run"> | undefined,
): Pick<ResidentRuntime, "run"> {
  if (!residentRuntime) throw new Error("dispatch resident handler requires residentRuntime owner");
  return residentRuntime;
}

function fallbackAgentResolver(model: Model.Ref | undefined): AgentResolver | undefined {
  if (model === undefined) return undefined;
  return { resolve: async () => ({ model }) };
}

function eventFromCommand(
  command: Dispatch.Command,
  context: Parameters<DispatchHandler>[1],
): Ingress.InternalEvent {
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
    ...(context?.workspaceRoot ? { workspace: context.workspaceRoot } : {}),
    runtime: {
      ...((command.target.sessionId ?? command.sessionId ?? context?.sessionId)
        ? { durableSessionId: command.target.sessionId ?? command.sessionId ?? context?.sessionId }
        : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
    },
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
  };
}

function originActorKind(actor: Dispatch.ActorContext): "resident" | "worker" | "system" {
  if (actor.kind === "resident" || actor.kind === "worker") return actor.kind;
  return "system";
}

function openPendingAsk(command: Dispatch.Command, fallbackSessionId: string): void {
  const tokenHash = typeof command.correlation === "string" ? command.correlation : undefined;
  PendingAskStore.create({
    id: command.dispatchId,
    originSessionId: command.actor.sessionId ?? command.sessionId ?? fallbackSessionId,
    ...((command.actor.runId ?? command.runId)
      ? { originRunId: command.actor.runId ?? command.runId }
      : {}),
    originActorKind: originActorKind(command.actor),
    targetKind: "resident",
    ...(command.target.id ? { targetActorId: command.target.id } : {}),
    correlation: tokenHash ? { tokenHash } : {},
  });
}

export function createResidentDispatchHandlers(
  options: ResidentDispatchHandlerOptions = {},
): Record<"resident.ask", DispatchHandler> {
  return {
    async "resident.ask"(command, context) {
      const residentRuntime = requireResidentRuntime(options.residentRuntime);
      const agentResolver = options.agentResolver ?? fallbackAgentResolver(options.defaultModel);
      if (command.target.kind !== "resident") {
        throw new Error("resident.ask requires resident target");
      }
      const sessionId = command.target.sessionId ?? command.sessionId ?? context?.sessionId;
      if (!sessionId)
        throw new Error("resident.ask requires target.sessionId or runtime sessionId");
      openPendingAsk(command, sessionId);
      try {
        const result = await IngressEngine.ingestInternal(eventFromCommand(command, context), {
          residentRuntime,
          ...(agentResolver ? { agentResolver } : {}),
        });
        if (result.kind === "dropped") {
          throw new Error(`resident.ask ingress was dropped: ${result.reason}`);
        }
        PendingAskStore.answer(command.dispatchId);
        return {
          output: {
            output: result.result.output,
            finishReason: result.result.finishReason,
          },
        };
      } catch (error) {
        PendingAskStore.expire(command.dispatchId);
        throw error;
      }
    },
  };
}
