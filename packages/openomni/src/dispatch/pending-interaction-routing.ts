import { Command, Execution, Wait } from "@openomni/protocol";
import type { PendingInteractionStore } from "@openomni/ledger";
import { findWaitCandidates } from "../wait/index.js";

// Correlation lookup is owned by wait/correlation.ts (THE single lookup);
// this module only routes a single FROZEN legacy PendingInteraction match
// (#548: the store is read-only, served via upcast-on-read) into the
// canonical dispatch command. It never writes: routing a frozen row leaves
// the row exactly as persisted. Ambiguity or a non-interaction match leaves
// the command unrouted, so the default dispatch authority denies it
// fail-closed (dispatch.pending_interaction.required /
// dispatch.actor.required).
function findPendingInteractionMatch(
  correlation: Wait.Correlation,
): PendingInteractionStore.Record | undefined {
  const resolution = findWaitCandidates({ correlation });
  return resolution.kind === "match" && resolution.candidate.source === "pending_interaction"
    ? resolution.candidate.record
    : undefined;
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
  command: Command.Request,
  match: PendingInteractionStore.Record,
): boolean {
  return (
    Wait.responderCandidates(
      Wait.targetsOfPendingInteraction(match),
      Wait.dispatchEvidence(command),
    ).length === 1
  );
}

export function routePendingInteraction(
  command: Command.Request,
  pinned?: PendingInteractionStore.Record,
): Command.Request {
  if (command.action !== Command.Actions.ActorMessage) return command;
  const match =
    pinned ??
    (command.correlation && typeof command.correlation !== "string"
      ? findPendingInteractionMatch(command.correlation)
      : undefined);
  if (!match) return command;
  if (!pendingInteractionSenderMatches(command, match)) return command;
  // The "invalid" sentinel (explicit but unparseable action) is disallowed
  // like any action outside allowedActions: the command stays unrouted and
  // the default dispatch authority denies it fail-closed.
  const action = Wait.requestedWaitAction(command.payload);
  if (action === "invalid" || !match.allowedActions.includes(action)) return command;
  if (action === "ask_clarification") {
    return Command.Request.parse({
      ...command,
      action: Command.Actions.ResidentAsk,
      target: {
        kind: "resident",
        sessionId: match.sessionId,
      },
      sessionId: match.sessionId,
      runId: match.workerRunId,
      wait: true,
      actor: {
        kind: "internal_worker",
        actorId: match.targetActorId ?? match.endpointId,
        sessionId: match.sessionId,
        runId: match.workerRunId,
        workerRunId: match.workerRunId,
        trustTier: "assigned_worker",
        labels: [
          "actor.internal_worker",
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
  return Command.Request.parse({
    ...command,
    payload,
    action: Command.Actions.WorkerComplete,
    target: {
      kind: "worker",
      id: match.workerRunId,
      runId: match.workerRunId,
      sessionId: match.sessionId,
    },
    sessionId: match.sessionId,
    runId: match.workerRunId,
    actor: {
      kind: "internal_worker",
      actorId: match.targetActorId ?? match.endpointId,
      sessionId: match.sessionId,
      runId: match.workerRunId,
      workerRunId: match.workerRunId,
      trustTier: "assigned_worker",
      labels: [
        "actor.internal_worker",
        "actor.assigned_worker",
        `pending_interaction.${match.id}`,
        `endpoint.${match.endpointId}`,
      ],
      reason: "pending_interaction.match",
    },
  });
}
