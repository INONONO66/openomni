import type { Dispatch, Ingress, Model } from "@openomni/protocol";
import type { DurableWaitV1, WaitKernelService } from "../../ingress/wait-correlation.js";
import type { ResidentRuntime } from "../../resident/runtime.js";
import { type AgentResolver, IngressEngine } from "../../ingress/engine.js";
import type { DispatchHandler } from "../registry.js";
import { findPendingInteractions } from "../pending-interaction-routing.js";

export interface ResidentDispatchHandlerOptions {
  readonly residentRuntime?: Pick<ResidentRuntime, "run">;
  readonly defaultModel?: Model.Ref;
  readonly agentResolver?: AgentResolver;
  readonly waitKernel: WaitKernelService;
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

export async function requireSuppliedWorkerWait(
  service: WaitKernelService,
  command: Dispatch.Command,
): Promise<DurableWaitV1> {
  if (
    command.actor.kind !== "worker" ||
    command.actor.trustTier !== "assigned_worker" ||
    !command.actor.workerRunId ||
    !command.actor.sessionId ||
    !command.actor.runId
  ) {
    throw new Error("resident.ask requires an authenticated Worker Wait reference");
  }
  if (!command.idempotencyKey || !command.correlation || typeof command.correlation === "string") {
    throw new Error("resident.ask requires a durable Wait reference and correlation");
  }

  const wait = (await findPendingInteractions(service, command.correlation)).find(
    (candidate) => candidate.waitId === command.idempotencyKey,
  );
  if (
    wait?.status !== "open" ||
    wait.opened.ownerRef.kind !== "workItem" ||
    wait.opened.attempt?.attemptId !== command.actor.workerRunId ||
    wait.route.kind !== "worker" ||
    wait.route.sessionId !== command.actor.sessionId ||
    wait.route.runId !== command.actor.runId
  ) {
    throw new Error("resident.ask supplied Wait is not bound to the authenticated Worker Attempt");
  }
  return wait;
}

function routedClarificationWaitId(command: Dispatch.Command): string | undefined {
  if (
    command.actor.kind !== "worker" ||
    command.actor.trustTier !== "assigned_worker" ||
    command.actor.reason !== "wait.match" ||
    command.target.kind !== "resident" ||
    command.target.sessionId !== command.actor.sessionId ||
    command.sessionId !== command.actor.sessionId ||
    command.runId !== command.actor.runId ||
    command.actor.workerRunId !== command.actor.runId ||
    command.payload === null ||
    typeof command.payload !== "object" ||
    !("action" in command.payload) ||
    command.payload.action !== "ask_clarification"
  ) {
    return undefined;
  }
  const waitLabels = (command.actor.labels ?? []).filter(
    (label) => label.startsWith("wait.") && label.length > 5,
  );
  return waitLabels.length === 1 ? waitLabels[0]?.slice(5) : undefined;
}

export function createResidentDispatchHandlers(
  options: ResidentDispatchHandlerOptions,
): Record<"resident.ask", DispatchHandler> {
  return {
    async "resident.ask"(command, context) {
      const routedWaitId = routedClarificationWaitId(command);
      if (routedWaitId !== undefined) {
        return { output: { waitId: routedWaitId, action: "ask_clarification", routed: true } };
      }
      const residentRuntime = requireResidentRuntime(options.residentRuntime);
      const waitKernel = options.waitKernel;
      const agentResolver = options.agentResolver ?? fallbackAgentResolver(options.defaultModel);
      if (command.target.kind !== "resident") {
        throw new Error("resident.ask requires resident target");
      }
      const sessionId = command.target.sessionId ?? command.sessionId ?? context?.sessionId;
      if (!sessionId)
        throw new Error("resident.ask requires target.sessionId or runtime sessionId");
      const wait = await requireSuppliedWorkerWait(waitKernel, command);
      try {
        const result = await IngressEngine.ingestInternal(eventFromCommand(command, context), {
          residentRuntime,
          ...(agentResolver ? { agentResolver } : {}),
        });
        if (result.kind === "dropped") {
          throw new Error(`resident.ask ingress was dropped: ${result.reason}`);
        }
        await waitKernel.settle({
          waitId: wait.waitId,
          transportId: command.dispatchId,
          responder: {
            version: "wait-responder-ref-v1",
            actorId: command.target.id ?? "resident",
          },
          action: "report_result",
          payload: result.result.output,
        });
        return {
          output: {
            output: result.result.output,
            finishReason: result.result.finishReason,
          },
        };
      } catch (error) {
        await waitKernel.cancel({
          waitId: wait.waitId,
          reason: error instanceof Error ? error.message : "resident.ask failed",
        });
        throw error;
      }
    },
  };
}
