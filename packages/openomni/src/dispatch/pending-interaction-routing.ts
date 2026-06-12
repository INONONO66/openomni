import { Dispatch } from "@openomni/protocol";
import { PendingInteractionStore } from "@openomni/session";

function correlationQueries(correlation: Dispatch.Command["correlation"]): Dispatch.Correlation[] {
  if (!correlation || typeof correlation === "string") return [];
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

function findPendingInteraction(command: Dispatch.Command) {
  const seen = new Set<string>();
  const matches: PendingInteractionStore.Record[] = [];
  for (const query of correlationQueries(command.correlation)) {
    for (const match of PendingInteractionStore.findByCorrelation(query)) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      matches.push(match);
    }
    if (matches.length > 0) break;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function markMatched(record: PendingInteractionStore.Record): PendingInteractionStore.Record {
  if (record.status === "open") return PendingInteractionStore.resolve(record.id);
  if (record.status === "resolved") return PendingInteractionStore.markFollowUp(record.id);
  return record;
}

export function routePendingInteraction(command: Dispatch.Command): Dispatch.Command {
  if (command.action !== Dispatch.Actions.ActorMessage) return command;
  const match = findPendingInteraction(command);
  if (!match) return command;
  if (!match.allowedActions.includes("report_result")) return command;
  return Dispatch.Command.parse({
    ...command,
    action: Dispatch.Actions.ActorReply,
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
  if (command.action !== Dispatch.Actions.ActorReply) return;
  if (command.actor.reason !== "pending_interaction.match") return;
  const pendingInteractionId = command.actor.labels
    ?.find((label) => label.startsWith("pending_interaction."))
    ?.slice("pending_interaction.".length);
  if (!pendingInteractionId) return;
  const record = PendingInteractionStore.get(pendingInteractionId);
  if (!record) return;
  markMatched(record);
}
