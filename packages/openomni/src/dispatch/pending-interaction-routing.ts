import { Dispatch, Execution } from "@openomni/protocol";
import { PendingInteractionStore } from "@openomni/session";

function correlationQueries(correlation: Dispatch.Correlation): Dispatch.Correlation[] {
  const base = {
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
  };
  const queries: Dispatch.Correlation[] = [];
  if (correlation.replyToMessageId) {
    queries.push({ ...base, replyToMessageId: correlation.replyToMessageId });
  }
  if (correlation.threadId) {
    queries.push({ ...base, threadId: correlation.threadId });
  }
  if (correlation.tokenHash) {
    queries.push({ ...base, tokenHash: correlation.tokenHash });
  }
  if (correlation.externalConversationId) {
    queries.push({ ...base, externalConversationId: correlation.externalConversationId });
  }
  if (queries.length === 0) queries.push(base);
  return queries;
}

export function findPendingInteractions(
  correlation: Dispatch.Correlation,
): readonly PendingInteractionStore.Record[] {
  const seen = new Set<string>();
  const matches: PendingInteractionStore.Record[] = [];
  for (const query of correlationQueries(correlation)) {
    for (const match of PendingInteractionStore.findByCorrelation(query)) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      matches.push(match);
    }
    if (matches.length > 0) break;
  }
  return matches;
}

function markMatched(record: PendingInteractionStore.Record): PendingInteractionStore.Record {
  if (record.status === "open") return PendingInteractionStore.resolve(record.id);
  if (record.status === "resolved") return PendingInteractionStore.markFollowUp(record.id);
  return record;
}

export function requestedPendingInteractionAction(
  payload: unknown,
): PendingInteractionStore.Record["allowedActions"][number] {
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
  match: PendingInteractionStore.Record,
): CanonicalWorkerCompletePayload | undefined {
  if (typeof payload === "string") {
    return {
      result: {
        runId: match.workerRunId,
        sessionId: match.sessionId,
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
        runId: match.workerRunId,
        sessionId: match.sessionId,
        status: "succeeded",
        output: value,
        finishReason: "stop",
      },
    };
  }

  const result = Execution.Result.safeParse(value);
  if (
    !result.success ||
    result.data.runId !== match.workerRunId ||
    result.data.sessionId !== match.sessionId
  ) {
    return undefined;
  }
  return { result: result.data };
}

function pendingInteractionSenderMatches(
  command: Dispatch.Command,
  match: PendingInteractionStore.Record,
): boolean {
  const correlation = command.correlation;
  if (correlation !== undefined && typeof correlation !== "string") {
    const bearerTokenMatches =
      match.targetActorId === undefined &&
      match.correlation.tokenHash !== undefined &&
      correlation.tokenHash === match.correlation.tokenHash;
    if (bearerTokenMatches) return true;
    if (correlation.endpointId !== match.endpointId) return false;
  }
  if (command.actor.kind === "unknown") {
    return match.targetActorId === undefined && command.actor.actorId === match.endpointId;
  }
  return match.targetActorId === undefined || command.actor.actorId === match.targetActorId;
}

export function routePendingInteraction(
  command: Dispatch.Command,
  pinned?: PendingInteractionStore.Record,
): Dispatch.Command {
  if (command.action !== Dispatch.Actions.ActorMessage) return command;
  const matches =
    pinned === undefined && command.correlation && typeof command.correlation !== "string"
      ? findPendingInteractions(command.correlation)
      : [];
  const match = pinned ?? (matches.length === 1 ? matches[0] : undefined);
  if (!match) return command;
  if (!pendingInteractionSenderMatches(command, match)) return command;
  const action = requestedPendingInteractionAction(command.payload);
  if (!match.allowedActions.includes(action)) return command;
  if (action === "ask_clarification") {
    return Dispatch.Command.parse({
      ...command,
      action: Dispatch.Actions.ResidentAsk,
      target: {
        kind: "resident",
        sessionId: match.sessionId,
      },
      sessionId: match.sessionId,
      runId: match.workerRunId,
      wait: true,
      actor: {
        kind: "worker",
        actorId: match.targetActorId ?? match.endpointId,
        sessionId: match.sessionId,
        runId: match.workerRunId,
        workerRunId: match.workerRunId,
        trustTier: "assigned_worker",
        labels: [
          "actor.worker",
          "actor.assigned_worker",
          `pending_interaction.${match.id}`,
          `endpoint.${match.endpointId}`,
        ],
        reason: "pending_interaction.match",
      },
    });
  }
  if (action !== "report_result") return command;
  const payload = canonicalWorkerCompletePayload(command.payload, match);
  if (payload === undefined) return command;
  return Dispatch.Command.parse({
    ...command,
    payload,
    action: Dispatch.Actions.WorkerComplete,
    target: {
      kind: "worker",
      id: match.workerRunId,
      runId: match.workerRunId,
      sessionId: match.sessionId,
    },
    sessionId: match.sessionId,
    runId: match.workerRunId,
    actor: {
      kind: "worker",
      actorId: match.targetActorId ?? match.endpointId,
      sessionId: match.sessionId,
      runId: match.workerRunId,
      workerRunId: match.workerRunId,
      trustTier: "assigned_worker",
      labels: [
        "actor.worker",
        "actor.assigned_worker",
        `pending_interaction.${match.id}`,
        `endpoint.${match.endpointId}`,
      ],
      reason: "pending_interaction.match",
    },
  });
}

export function markRoutedPendingInteraction(command: Dispatch.Command): void {
  if (
    command.action !== Dispatch.Actions.ActorReply &&
    command.action !== Dispatch.Actions.WorkerComplete &&
    command.action !== Dispatch.Actions.ResidentAsk
  ) {
    return;
  }
  if (command.actor.reason !== "pending_interaction.match") return;
  const pendingInteractionId = command.actor.labels
    ?.find((label) => label.startsWith("pending_interaction."))
    ?.slice("pending_interaction.".length);
  if (!pendingInteractionId) return;
  const record = PendingInteractionStore.get(pendingInteractionId);
  if (!record) return;
  markMatched(record);
}
