import {
  canonicalDigest,
  PlainValueSchema,
  SessionTransition,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type PlainValue,
} from "@openomni/protocol";

export interface RequestDecision {
  readonly resolution: SessionTransition.Resolution;
  readonly request?: SessionTransition.Request;
  readonly actions: readonly LedgerAction.Append[];
  readonly receive?: Inbox.Commit;
  readonly requestCount?: LedgerSession.Commit["requestCount"];
}

interface RequestSnapshot {
  readonly row: LedgerSession.Row;
  readonly actions: readonly LedgerAction.Node[];
  readonly request?: SessionTransition.Request;
  readonly domainRevisions?: Readonly<Record<string, number>>;
  readonly requests?: readonly SessionTransition.Request[];
}

const rejected: RequestDecision = { resolution: "rejected", actions: [] };

export function requestBindingDigest(request: SessionTransition.Request): string {
  return canonicalDigest({
    requestId: request.requestId,
    sessionId: request.sessionId,
    callId: request.callId,
    mode: request.mode,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsGeneration: request.toolsGeneration,
    toolsHash: request.toolsHash,
    systemHash: request.systemHash,
    domainRevisions: request.domainRevisions,
    deadline: request.deadline,
    expectedResponders: request.expectedResponders,
    correlation: request.correlation,
    allowedActions: request.allowedActions,
    resolution: request.resolution,
    threshold: request.threshold,
  });
}

/** Pure request authority. The caller applies the whole plan under the captured lease/revision. */
export function decideRequestTransition(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
): RequestDecision {
  const parsed = SessionTransition.Command.safeParse(command);
  if (!parsed.success) return rejected;
  if (!ownsRequestRevision(command, snapshot.row)) return rejected;
  const inputDigest = requestInputDigest(command.payload);
  const repeated = repeatedInput(command, snapshot, inputDigest);
  if (repeated !== undefined) return repeated;
  const { payload } = command;
  if (payload.kind === "request.open") {
    return openRequest(command, snapshot, payload.request, inputDigest);
  }
  const requestId =
    payload.kind === "request.answer"
      ? payload.answer.requestId
      : payload.kind === "request.delivery"
        ? payload.receipt.requestId
        : payload.requestId;
  const request = snapshot.request;
  if (
    request === undefined ||
    request.requestId !== requestId ||
    request.sessionId !== snapshot.row.id
  )
    return rejected;
  if (payload.kind === "request.delivery") {
    return recordDelivery(command, request, payload.receipt, inputDigest);
  }
  if (payload.kind === "request.answer") {
    return answerRequest(command, snapshot, request, payload.answer, inputDigest);
  }
  return closeRequest(command, request, payload, inputDigest);
}

function ownsRequestRevision(command: SessionTransition.Command, row: LedgerSession.Row): boolean {
  return (
    row.id === command.sessionId &&
    row.leaseOwner === command.authority.owner &&
    row.leaseFence === command.authority.fence &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > command.at &&
    row.revision === command.expectedRevision
  );
}

function repeatedInput(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  inputDigest: string,
): RequestDecision | undefined {
  for (const action of snapshot.actions) {
    const intent = objectValue(action.intent.value);
    if (intent?.inputId !== command.inputId) continue;
    if (intent.inputDigest !== inputDigest) return rejected;
    const resolution = SessionTransition.Resolution.safeParse(
      objectValue(action.effect.value)?.resolution,
    );
    return resolution.success
      ? { resolution: resolution.data, request: snapshot.request, actions: [] }
      : rejected;
  }
  return undefined;
}

function recordRequest(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  inputDigest: string,
  resolution: SessionTransition.Resolution,
  terminal = false,
): RequestDecision {
  const { payload } = command;
  const parentId = request.requestId;
  const writes: LedgerAction.Append[] = [
    {
      id: `${parentId}:input:${command.inputId}`,
      parentId,
      sessionId: command.sessionId,
      kind: payload.kind === "request.answer" ? "reply" : "request",
      intent: {
        encodingVersion: 1,
        value: { inputId: command.inputId, inputDigest, command: payload.kind },
      },
      effect: {
        encodingVersion: 1,
        value: PlainValueSchema.parse({
          phase: "state",
          request,
          resolution,
          ...(payload.kind === "request.answer" ? { answer: payload.answer } : {}),
          ...(payload.kind === "request.delivery" ? { receipt: payload.receipt } : {}),
        }),
      },
      ts: command.at,
      irreversible: true,
    },
  ];
  if (terminal) {
    writes.push({
      id: `${parentId}:resolution`,
      parentId,
      sessionId: command.sessionId,
      kind: "request",
      intent: { encodingVersion: 1, value: { phase: "resolution" } },
      effect: {
        encodingVersion: 1,
        value: PlainValueSchema.parse({ phase: "state", request, resolution }),
      },
      ts: command.at,
      irreversible: true,
    });
  }
  const receive = receivingIntake(command, request, resolution);
  return { resolution, request, actions: writes, ...(receive === undefined ? {} : { receive }) };
}

function receivingIntake(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): Inbox.Commit | undefined {
  const { payload } = command;
  if (
    payload.kind !== "request.answer" ||
    request.mode !== "reply" ||
    (resolution !== "attached" && resolution !== "resolved")
  )
    return undefined;
  const { answer } = payload;
  return {
    id: answer.inputId,
    sessionId: request.sessionId,
    kind: "prompt",
    content: answer.content,
    createdAt: command.at,
    parentActionId: request.requestId,
    origin: {
      encodingVersion: 1,
      value: PlainValueSchema.parse(
        answer.outbound ?? {
          kind: "external_reply",
          messageId: answer.inputId,
          sourceActionId: request.requestId,
          replyTo: request.requestId,
        },
      ),
    },
  };
}

function openRequest(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  next: SessionTransition.Request,
  inputDigest: string,
): RequestDecision {
  const since = command.at - 3_600_000;
  const requestCount =
    next.mode === "approval"
      ? {
          since,
          count: (snapshot.requests ?? []).filter(
            (existing) =>
              existing.mode === "approval" &&
              existing.state === "open" &&
              existing.createdAt > since,
          ).length,
        }
      : undefined;
  if (requestCount !== undefined && requestCount.count >= 8) return rejected;
  if (
    snapshot.request !== undefined ||
    !originalInvocationMatches(next, snapshot) ||
    next.sessionId !== snapshot.row.id ||
    next.state !== "open" ||
    next.outcome !== null ||
    next.seenReplyIds.length > 0 ||
    next.replies.length > 0 ||
    !generationMatches(next, snapshot.row) ||
    next.bindingDigest !== requestBindingDigest(next)
  )
    return rejected;
  return {
    ...recordRequest(command, next, inputDigest, "opened"),
    ...(requestCount === undefined ? {} : { requestCount }),
  };
}

function originalInvocationMatches(
  next: SessionTransition.Request,
  snapshot: RequestSnapshot,
): boolean {
  const original = snapshot.actions.find((action) => action.id === next.requestId);
  const invocation = objectValue(original?.intent.value);
  return !(
    original?.sessionId !== snapshot.row.id ||
    invocation?.phase !== "intent" ||
    invocation.value === undefined ||
    canonicalDigest(invocation.value) !== next.inputHash ||
    canonicalDigest(next.parsedInput) !== next.inputHash ||
    invocation.effectHash !== next.effectHash ||
    (invocation.domainRevisions !== undefined &&
      canonicalDigest(invocation.domainRevisions) !== canonicalDigest(next.domainRevisions))
  );
}

function generationMatches(request: SessionTransition.Request, row: LedgerSession.Row): boolean {
  return (
    request.generation === row.policyGeneration &&
    request.toolsGeneration === row.toolsGeneration &&
    request.systemHash === row.systemHash
  );
}

function recordDelivery(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  receipt: SessionTransition.DeliveryReceipt,
  inputDigest: string,
): RequestDecision {
  let request = current;
  if (receipt.sessionId !== command.sessionId || receipt.sourceActionId !== request.requestId)
    return rejected;
  if (receipt.externalMessageId !== undefined) {
    request = {
      ...request,
      correlation: { ...request.correlation, replyToMessageId: receipt.externalMessageId },
    };
    request.bindingDigest = requestBindingDigest(request);
  }
  return recordRequest(command, request, inputDigest, "delivery_recorded");
}

function answerRequest(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  let request = current;
  if (answer.sessionId !== command.sessionId || answer.inputId !== command.inputId) return rejected;
  if (answer.receivedAt >= request.deadline) {
    const terminal = request.state === "open";
    request = withSeenReply(request, answer.inputId);
    if (terminal) request = { ...request, state: "expired", outcome: "outcome_unknown" };
    return recordRequest(command, request, inputDigest, "late_unknown", terminal);
  }
  if (!answerBindingMatches(answer, request, snapshot))
    return recordRequest(command, request, inputDigest, "rejected");
  const previouslySeen = request.seenReplyIds.includes(answer.inputId);
  request = withSeenReply(request, answer.inputId);
  if (
    request.state !== "open" ||
    previouslySeen ||
    request.replies.some((reply) => reply.responderId === answer.principal.principalId)
  )
    return recordRequest(command, request, inputDigest, "duplicate");
  request = {
    ...request,
    replies: [
      ...request.replies,
      {
        replyId: answer.inputId,
        responderId: answer.principal.principalId,
        content: answer.content,
        receivedAt: answer.receivedAt,
      },
    ],
  };
  if (answer.decision === "refuse") {
    request = { ...request, state: "refused", outcome: "denied" };
    return recordRequest(command, request, inputDigest, "refused", true);
  }
  if (request.replies.length >= request.threshold) {
    request = { ...request, state: "resolved", outcome: "answered" };
    return recordRequest(command, request, inputDigest, "resolved", true);
  }
  return recordRequest(command, request, inputDigest, "attached");
}

function withSeenReply(request: SessionTransition.Request, inputId: string): SessionTransition.Request {
  return { ...request, seenReplyIds: [...new Set([...request.seenReplyIds, inputId])] };
}

function answerBindingMatches(
  answer: SessionTransition.Answer,
  request: SessionTransition.Request,
  snapshot: RequestSnapshot,
): boolean {
  const principalValid =
    request.mode === "approval"
      ? answer.principal.kind === "owner" && answer.decision !== "reply"
      : answer.decision !== "approve";
  return (
    principalValid &&
    request.expectedResponders.includes(answer.principal.principalId) &&
    answer.bindingDigest === request.bindingDigest &&
    answer.inputHash === request.inputHash &&
    answer.effectHash === request.effectHash &&
    answer.generation === request.generation &&
    answer.toolsHash === request.toolsHash &&
    request.allowedActions.includes(answer.allowedAction) &&
    canonicalDigest(answer.domainRevisions) === canonicalDigest(request.domainRevisions) &&
    domainRevisionsMatch(request, snapshot.domainRevisions) &&
    generationMatches(request, snapshot.row)
  );
}

function domainRevisionsMatch(
  request: SessionTransition.Request,
  current: Readonly<Record<string, number>> | undefined,
): boolean {
  if (current === undefined) return Object.keys(request.domainRevisions).length === 0;
  return canonicalDigest({ ...current }) === canonicalDigest(request.domainRevisions);
}

function closeRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  payload: Extract<SessionTransition.Payload, { kind: "request.timeout" | "request.cancel" }>,
  inputDigest: string,
): RequestDecision {
  let request = current;
  if (request.state !== "open") return recordRequest(command, request, inputDigest, "duplicate");
  if (payload.kind === "request.timeout") {
    if (command.at < request.deadline) return rejected;
    request = { ...request, state: "expired", outcome: "outcome_unknown" };
    return recordRequest(command, request, inputDigest, "expired", true);
  }
  if (
    payload.principal.kind !== "owner" &&
    !(payload.principal.kind === "session" && payload.principal.principalId === command.sessionId)
  )
    return recordRequest(command, request, inputDigest, "rejected");
  request = { ...request, state: "cancelled", outcome: "cancelled" };
  return recordRequest(command, request, inputDigest, "cancelled", true);
}

function requestInputDigest(payload: SessionTransition.Payload): string {
  if (payload.kind === "request.answer") {
    const { receivedAt: _receivedAt, ...answer } = payload.answer;
    return canonicalDigest(PlainValueSchema.parse({ kind: payload.kind, answer }));
  }
  if (payload.kind === "request.delivery") {
    const { at: _at, ...receipt } = payload.receipt;
    return canonicalDigest(PlainValueSchema.parse({ kind: payload.kind, receipt }));
  }
  return canonicalDigest(PlainValueSchema.parse(payload));
}

function objectValue(value: PlainValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
