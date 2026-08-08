import { Dispatch, Execution } from "@openomni/protocol";
import { PendingInteractionStore } from "@openomni/session";
import {
  dispatchEvidence,
  findWaitCandidates,
  responderCandidates,
  targetsOfPendingInteraction,
} from "../wait/index.js";

// Correlation lookup is owned by wait/correlation.ts (THE single lookup);
// this module only routes a single legacy PendingInteraction match into the
// canonical dispatch command. Ambiguity or a non-interaction match leaves the
// command unrouted, so the default dispatch authority denies it fail-closed
// (dispatch.pending_interaction.required / dispatch.actor.required).
function findPendingInteractionMatch(
  correlation: Dispatch.Correlation,
): PendingInteractionStore.Record | undefined {
  const resolution = findWaitCandidates({ correlation });
  return resolution.kind === "match" && resolution.candidate.source === "pending_interaction"
    ? resolution.candidate.record
    : undefined;
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

// Sender matching is owned by wait/matcher.ts (one core, dispatch actor
// context as the phase evidence); exactly one credited responder routes.
// Endpoint proof (or a pinned actor identity) is the SOLE authorization for
// legacy PendingInteraction rows: correlation.tokenHash is a lookup
// precedence level, never a credential — a wrong token still reaches the
// scoped level, and only the sender matcher admits or refuses the command.
function pendingInteractionSenderMatches(
  command: Dispatch.Command,
  match: PendingInteractionStore.Record,
): boolean {
  return (
    responderCandidates(targetsOfPendingInteraction(match), dispatchEvidence(command)).length === 1
  );
}

export function routePendingInteraction(
  command: Dispatch.Command,
  pinned?: PendingInteractionStore.Record,
): Dispatch.Command {
  if (command.action !== Dispatch.Actions.ActorMessage) return command;
  const match =
    pinned ??
    (command.correlation && typeof command.correlation !== "string"
      ? findPendingInteractionMatch(command.correlation)
      : undefined);
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
