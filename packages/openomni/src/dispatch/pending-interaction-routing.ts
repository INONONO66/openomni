import { createHash } from "node:crypto";
import { Dispatch, Execution, type Wait } from "@openomni/protocol";
import type { DurableWaitV1, WaitKernelService } from "../ingress/wait-correlation.js";

export async function findPendingInteractions(
  service: WaitKernelService,
  correlation: Dispatch.Correlation,
): Promise<readonly DurableWaitV1[]> {
  const resolution = await service.correlate({
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: {
      version: "wait-correlation-v1",
      ...(correlation.threadId === undefined ? {} : { threadId: correlation.threadId }),
      ...(correlation.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: correlation.replyToMessageId }),
      ...(correlation.tokenHash === undefined ? {} : { tokenHash: correlation.tokenHash }),
      ...(correlation.externalConversationId === undefined
        ? {}
        : { externalConversationId: correlation.externalConversationId }),
    },
  });
  if (resolution.kind === "none") return [];
  if (resolution.kind === "match") return [resolution.candidate.wait];
  return resolution.candidates.map((candidate) => candidate.wait);
}

export function requestedPendingInteractionAction(payload: unknown): Wait.AllowedActionV1 {
  if (payload && typeof payload === "object" && "action" in payload) {
    const action = payload.action;
    if (
      action === "report_result" ||
      action === "ask_clarification" ||
      action === "attach_artifact" ||
      action === "decline_task"
    ) {
      return action;
    }
  }
  return "report_result";
}

type CanonicalWorkerCompletePayload = Readonly<{
  result: Execution.Result;
}>;

function canonicalWorkerCompletePayload(
  payload: unknown,
  wait: DurableWaitV1,
): CanonicalWorkerCompletePayload | undefined {
  if (wait.route.kind !== "worker") return undefined;
  if (typeof payload === "string") {
    return {
      result: {
        runId: wait.route.runId,
        sessionId: wait.route.sessionId,
        status: "succeeded",
        output: payload,
        finishReason: "stop",
      },
    };
  }
  if (typeof payload !== "object" || payload === null || !("action" in payload)) return undefined;
  if (payload.action !== "report_result") return undefined;

  const value =
    "result" in payload ? payload.result : "output" in payload ? payload.output : undefined;
  if (typeof value === "string") {
    return {
      result: {
        runId: wait.route.runId,
        sessionId: wait.route.sessionId,
        status: "succeeded",
        output: value,
        finishReason: "stop",
      },
    };
  }

  const result = Execution.Result.safeParse(value);
  if (
    !result.success ||
    result.data.runId !== wait.route.runId ||
    result.data.sessionId !== wait.route.sessionId
  ) {
    return undefined;
  }
  return { result: result.data };
}

function waitCorrelation(command: Dispatch.Command): Wait.CorrelationV1 | undefined {
  const correlation = command.correlation;
  if (correlation === undefined || typeof correlation === "string") return undefined;
  return {
    version: "wait-correlation-v1",
    ...(correlation.tokenHash === undefined ? {} : { tokenHash: correlation.tokenHash }),
    ...(correlation.threadId === undefined ? {} : { threadId: correlation.threadId }),
    ...(correlation.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: correlation.replyToMessageId }),
    ...(correlation.externalConversationId === undefined
      ? {}
      : { externalConversationId: correlation.externalConversationId }),
  };
}

function correlationsMatch(left: Wait.CorrelationV1, right: Wait.CorrelationV1): boolean {
  return (
    left.tokenHash === right.tokenHash &&
    left.threadId === right.threadId &&
    left.replyToMessageId === right.replyToMessageId &&
    left.externalConversationId === right.externalConversationId
  );
}

function expectedResponder(
  command: Dispatch.Command,
  wait: DurableWaitV1,
): Wait.ResponderRefV1 | undefined {
  const correlation = command.correlation;
  const nativeCorrelation = waitCorrelation(command);
  if (
    correlation === undefined ||
    typeof correlation === "string" ||
    nativeCorrelation === undefined
  ) {
    return undefined;
  }
  if (
    correlation.endpointId !== wait.opened.endpointId ||
    correlation.channelId !== wait.opened.channelId ||
    !correlationsMatch(nativeCorrelation, wait.opened.correlation) ||
    (wait.opened.targetActorId !== undefined && command.actor.actorId !== wait.opened.targetActorId)
  ) {
    return undefined;
  }
  return wait.opened.expectedResponders.find(
    (candidate) =>
      candidate.actorId === command.actor.actorId &&
      (candidate.endpointId === undefined || candidate.endpointId === correlation.endpointId),
  );
}

function responseTransportId(command: Dispatch.Command, action: Wait.AllowedActionV1): string {
  if (command.idempotencyKey !== undefined) return command.idempotencyKey;
  return createHash("sha256")
    .update(
      JSON.stringify({
        action,
        actorId: command.actor.actorId,
        correlation: command.correlation,
      }),
    )
    .digest("hex");
}

export async function routePendingInteraction(
  service: WaitKernelService,
  command: Dispatch.Command,
  pinned?: DurableWaitV1,
): Promise<Dispatch.Command> {
  if (command.action !== Dispatch.Actions.ActorMessage) return command;
  const matches =
    pinned === undefined && command.correlation && typeof command.correlation !== "string"
      ? await findPendingInteractions(service, command.correlation)
      : [];
  const matchedWait = pinned ?? (matches.length === 1 ? matches[0] : undefined);
  if (matchedWait?.route.kind !== "worker") return command;
  const responder = expectedResponder(command, matchedWait);
  if (responder === undefined) return command;
  const action = requestedPendingInteractionAction(command.payload);
  if (!matchedWait.opened.allowedActions.includes(action)) return command;
  const payload =
    action === "report_result"
      ? canonicalWorkerCompletePayload(command.payload, matchedWait)
      : undefined;
  if (action === "report_result" && payload === undefined) return command;
  if (action !== "report_result" && action !== "ask_clarification") return command;
  const wait = await service.acceptResponse({
    waitId: matchedWait.waitId,
    transportId: responseTransportId(command, action),
    responder,
    action,
    payload: command.payload,
  });
  if (
    wait.status !== "resolved" ||
    wait.route.kind !== "worker" ||
    wait.routedDispatchId === undefined ||
    wait.routedAction !== action
  ) {
    return command;
  }
  if (action === "ask_clarification") {
    return Dispatch.Command.parse({
      ...command,
      dispatchId: wait.routedDispatchId,
      action: Dispatch.Actions.ResidentAsk,
      target: { kind: "resident", sessionId: wait.route.sessionId },
      sessionId: wait.route.sessionId,
      runId: wait.route.runId,
      wait: true,
      actor: {
        kind: "worker",
        actorId: wait.opened.targetActorId ?? wait.opened.endpointId ?? "wait-responder",
        sessionId: wait.route.sessionId,
        runId: wait.route.runId,
        workerRunId: wait.route.runId,
        trustTier: "assigned_worker",
        labels: [
          "actor.worker",
          "actor.assigned_worker",
          `wait.${wait.waitId}`,
          ...(wait.opened.endpointId === undefined ? [] : [`endpoint.${wait.opened.endpointId}`]),
        ],
        reason: "wait.match",
      },
    });
  }
  if (action !== "report_result" || payload === undefined) return command;
  return Dispatch.Command.parse({
    ...command,
    dispatchId: wait.routedDispatchId,
    payload,
    action: Dispatch.Actions.WorkerComplete,
    target: {
      kind: "worker",
      id: wait.route.runId,
      runId: wait.route.runId,
      sessionId: wait.route.sessionId,
    },
    sessionId: wait.route.sessionId,
    runId: wait.route.runId,
    actor: {
      kind: "worker",
      actorId: wait.opened.targetActorId ?? wait.opened.endpointId ?? "wait-responder",
      sessionId: wait.route.sessionId,
      runId: wait.route.runId,
      workerRunId: wait.route.runId,
      trustTier: "assigned_worker",
      labels: [
        "actor.worker",
        "actor.assigned_worker",
        `wait.${wait.waitId}`,
        ...(wait.opened.endpointId === undefined ? [] : [`endpoint.${wait.opened.endpointId}`]),
      ],
      reason: "wait.match",
    },
  });
}

export async function markRoutedPendingInteraction(
  service: WaitKernelService,
  command: Dispatch.Command,
): Promise<void> {
  if (
    command.action !== Dispatch.Actions.ActorReply &&
    command.action !== Dispatch.Actions.WorkerComplete &&
    command.action !== Dispatch.Actions.ResidentAsk
  ) {
    return;
  }
  if (command.actor.reason !== "wait.match") return;
  const waitId = command.actor.labels?.find((label) => label.startsWith("wait."))?.slice(5);
  if (!waitId) return;
  await service.markRouted({
    waitId,
    dispatchId: command.dispatchId,
    action: requestedPendingInteractionAction(command.payload),
  });
}
