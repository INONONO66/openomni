import type { Command, Ingress, Model } from "@openomni/protocol";
import type { ResidentRuntime } from "../../resident/runtime.js";
import type { AgentResolver, IngressEngine } from "../../ingress/engine.js";
import { WaitService } from "../../wait/index.js";
import type { DispatchHandler } from "../registry.js";

export interface ResidentDispatchHandlerOptions {
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly defaultModel?: Model.Ref;
  readonly agentResolver?: AgentResolver;
  /** Ingress engine instance owning resident execution (#549); fail-closed when absent. */
  readonly ingress?: Pick<IngressEngine, "ingestInternal">;
}

function requireResidentRuntime(
  residentRuntime: Pick<ResidentRuntime, "run"> | undefined,
): Pick<ResidentRuntime, "run"> {
  if (!residentRuntime) throw new Error("dispatch resident handler requires residentRuntime owner");
  return residentRuntime;
}

function requireIngress(
  ingress: Pick<IngressEngine, "ingestInternal"> | undefined,
): Pick<IngressEngine, "ingestInternal"> {
  if (!ingress) throw new Error("dispatch resident handler requires ingress owner");
  return ingress;
}

function fallbackAgentResolver(model: Model.Ref | undefined): AgentResolver | undefined {
  if (model === undefined) return undefined;
  return { resolve: async () => ({ model }) };
}

function eventFromCommand(
  command: Command.Request,
  context: Parameters<DispatchHandler>[1],
): Ingress.InternalEvent {
  return {
    id: command.dispatchId,
    // D11: the dispatch command already carries the caller's trace — inherit it.
    traceId: command.traceId,
    surface: "dispatch",
    mode: "internal",
    agentName: "resident",
    target: {
      kind: "resident",
      ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
    },
    payload: command.payload,
    ...(context?.workspaceRoot ? { workspace: context.workspaceRoot } : {}),
    activation: {
      ...((command.target.sessionId ?? command.sessionId ?? context?.sessionId)
        ? { durableSessionId: command.target.sessionId ?? command.sessionId ?? context?.sessionId }
        : {}),
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

// The synchronous resident.ask path resolves inside this one dispatch, so it
// records Wait.Events.SyncAsk audit events only and never writes a PendingAsk
// or Wait row (#215 owner decision 2). Historical PendingAsk rows stay
// readable through the wait/upcast read path.
function auditSyncAsk(
  command: Command.Request,
  fallbackSessionId: string,
  phase: "opened" | "answered" | "failed",
): void {
  WaitService.auditSyncAsk({
    dispatchId: command.dispatchId,
    traceId: command.traceId,
    sessionId: command.actor.sessionId ?? command.sessionId ?? fallbackSessionId,
    phase,
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
      const ingress = requireIngress(options.ingress);
      auditSyncAsk(command, sessionId, "opened");
      try {
        const result = await ingress.ingestInternal(eventFromCommand(command, context), {
          residentRuntime,
          ...(agentResolver ? { agentResolver } : {}),
          // #500 A2: the live AbortSignal rides the call path, not the event.
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        if (result.kind === "dropped") {
          throw new Error(`resident.ask ingress was dropped: ${result.reason}`);
        }
        auditSyncAsk(command, sessionId, "answered");
        return {
          output: {
            output: result.result.output,
            finishReason: result.result.finishReason,
          },
        };
      } catch (error) {
        auditSyncAsk(command, sessionId, "failed");
        throw error;
      }
    },
  };
}
