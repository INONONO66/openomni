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

function all(...checks: readonly boolean[]): boolean {
  return checks.every((check) => check);
}

function requestEffect(
  action: LedgerAction.Node | undefined,
): SessionTransition.Request | undefined {
  const parsed = SessionTransition.Request.safeParse(objectValue(action?.effect.value)?.request);
  return parsed.success ? parsed.data : undefined;
}

export function findSessionRequest(
  actions: readonly LedgerAction.Node[],
  requestId: string,
): SessionTransition.Request | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const request = requestEffect(actions[index]);
    if (request?.requestId === requestId) return request;
  }
  return undefined;
}

type CapturedApproval = Omit<import("./executor-contract").ExecutionApprovalRequest, "durable">;

function generationDefaults(captured: CapturedApproval) {
  return {
    toolsGeneration: captured.toolsGeneration ?? 0,
    toolsHash: captured.toolsHash ?? canonicalDigest([]),
  };
}

export function createApprovalRequest(
  captured: CapturedApproval,
  binding: {
    readonly effect: PlainValue;
    readonly domainRevisions?: Readonly<Record<string, number>>;
  },
  systemHash: string | undefined,
  createdAt: number,
  timeout: number,
): SessionTransition.Request {
  const request = SessionTransition.Request.parse({
    requestId: captured.id,
    sessionId: captured.sessionId,
    turnId: captured.turnId,
    callId: captured.callId,
    mode: "approval",
    parsedInput: captured.intent,
    inputHash: captured.inputHash,
    effectHash: canonicalDigest(binding.effect),
    generation: captured.generation,
    ...generationDefaults(captured),
    systemHash: systemHash ?? canonicalDigest([]),
    domainRevisions: binding.domainRevisions ?? {},
    deadline: createdAt + timeout,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "pending",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt,
  });
  return { ...request, bindingDigest: requestBindingDigest(request) };
}

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
  if (
    !SessionTransition.Command.safeParse(command).success ||
    !ownsRequestRevision(command, snapshot.row)
  )
    return rejected;
  const inputDigest = requestInputDigest(command.payload);
  return (
    repeatedInput(command, snapshot, inputDigest) ?? transition(command, snapshot, inputDigest)
  );
}

type ExistingPayload = Exclude<SessionTransition.Payload, { kind: "request.open" }>;

function targetRequestId(payload: ExistingPayload): string {
  if (payload.kind === "request.answer") return payload.answer.requestId;
  return payload.kind === "request.delivery" ? payload.receipt.requestId : payload.requestId;
}

function transition(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  inputDigest: string,
): RequestDecision {
  const { payload } = command;
  if (payload.kind === "request.open") {
    return openRequest(command, snapshot, payload.request, inputDigest);
  }
  const request = snapshot.request;
  if (request === undefined || !targets(request, payload, snapshot.row.id)) return rejected;
  return transitionExisting(command, snapshot, request, payload, inputDigest);
}

function targets(
  request: SessionTransition.Request,
  payload: ExistingPayload,
  sessionId: string,
): boolean {
  return request.requestId === targetRequestId(payload) && request.sessionId === sessionId;
}

function transitionExisting(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  request: SessionTransition.Request,
  payload: ExistingPayload,
  inputDigest: string,
): RequestDecision {
  if (payload.kind === "request.delivery") {
    return recordDelivery(command, request, payload.receipt, inputDigest);
  }
  if (payload.kind === "request.answer") {
    return answerRequest(command, snapshot, request, payload.answer, inputDigest);
  }
  return closeRequest(command, request, payload, inputDigest);
}

function ownsRequestRevision(command: SessionTransition.Command, row: LedgerSession.Row): boolean {
  return all(
    row.id === command.sessionId,
    row.leaseOwner === command.authority.owner,
    row.leaseFence === command.authority.fence,
    row.leaseExpiresAt !== null && row.leaseExpiresAt > command.at,
    row.revision === command.expectedRevision,
  );
}

function recordedResolution(action: LedgerAction.Node): SessionTransition.Resolution | undefined {
  const resolution = SessionTransition.Resolution.safeParse(
    objectValue(action.effect.value)?.resolution,
  );
  return resolution.success ? resolution.data : undefined;
}

function replayedInput(
  action: LedgerAction.Node,
  request: SessionTransition.Request | undefined,
  inputDigest: string,
): RequestDecision {
  if (objectValue(action.intent.value)?.inputDigest !== inputDigest) return rejected;
  const resolution = recordedResolution(action);
  return resolution === undefined ? rejected : { resolution, request, actions: [] };
}

function repeatedInput(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  inputDigest: string,
): RequestDecision | undefined {
  const previous = snapshot.actions.find(
    (action) => objectValue(action.intent.value)?.inputId === command.inputId,
  );
  if (previous === undefined) return undefined;
  return replayedInput(previous, snapshot.request, inputDigest);
}

function payloadEvidence(payload: SessionTransition.Payload) {
  if (payload.kind === "request.answer") return { answer: payload.answer };
  if (payload.kind === "request.delivery") return { receipt: payload.receipt };
  return {};
}

function inputRecord(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  inputDigest: string,
  resolution: SessionTransition.Resolution,
): LedgerAction.Append {
  const { payload } = command;
  const parentId = request.requestId;
  return {
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
        ...payloadEvidence(payload),
      }),
    },
    ts: command.at,
    irreversible: true,
  };
}

function resolutionRecord(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): LedgerAction.Append {
  const parentId = request.requestId;
  return {
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
  };
}

function recordRequest(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  inputDigest: string,
  resolution: SessionTransition.Resolution,
  terminal = false,
): RequestDecision {
  const writes: LedgerAction.Append[] = [inputRecord(command, request, inputDigest, resolution)];
  if (terminal) writes.push(resolutionRecord(command, request, resolution));
  const receive = receivingIntake(command, request, resolution);
  return { resolution, request, actions: writes, ...(receive === undefined ? {} : { receive }) };
}

function receivesReply(
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): boolean {
  return request.mode === "reply" && (resolution === "attached" || resolution === "resolved");
}

function replyIntake(
  at: number,
  request: SessionTransition.Request,
  answer: SessionTransition.Answer,
): Inbox.Commit {
  return {
    id: answer.inputId,
    sessionId: request.sessionId,
    kind: "prompt",
    content: answer.content,
    createdAt: at,
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

function receivingIntake(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  resolution: SessionTransition.Resolution,
): Inbox.Commit | undefined {
  const { payload } = command;
  if (payload.kind !== "request.answer" || !receivesReply(request, resolution)) return undefined;
  return replyIntake(command.at, request, payload.answer);
}

type ApprovalCount = NonNullable<LedgerSession.Commit["requestCount"]>;

function openApprovalSince(existing: SessionTransition.Request, since: number): boolean {
  return existing.mode === "approval" && existing.state === "open" && existing.createdAt > since;
}

function openApprovalCount(
  snapshot: RequestSnapshot,
  next: SessionTransition.Request,
  since: number,
): ApprovalCount | undefined {
  if (next.mode !== "approval") return undefined;
  const open = (snapshot.requests ?? []).filter((existing) => openApprovalSince(existing, since));
  return { since, count: open.length };
}

function exceedsApprovalBudget(requestCount: ApprovalCount | undefined): boolean {
  return requestCount !== undefined && requestCount.count >= 8;
}

function freshRequestShape(next: SessionTransition.Request): boolean {
  return all(
    next.state === "open",
    next.outcome === null,
    next.seenReplyIds.length === 0,
    next.replies.length === 0,
  );
}

function admitsOpen(next: SessionTransition.Request, snapshot: RequestSnapshot): boolean {
  return all(
    snapshot.request === undefined,
    originalInvocationMatches(next, snapshot),
    next.sessionId === snapshot.row.id,
    freshRequestShape(next),
    generationMatches(next, snapshot.row),
    next.bindingDigest === requestBindingDigest(next),
  );
}

function openRequest(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  next: SessionTransition.Request,
  inputDigest: string,
): RequestDecision {
  const requestCount = openApprovalCount(snapshot, next, command.at - 3_600_000);
  if (exceedsApprovalBudget(requestCount) || !admitsOpen(next, snapshot)) return rejected;
  return {
    ...recordRequest(command, next, inputDigest, "opened"),
    ...(requestCount === undefined ? {} : { requestCount }),
  };
}

function intentInvocation(invocation: ReturnType<typeof objectValue>) {
  return invocation?.phase === "intent" ? invocation : undefined;
}

function recordedInvocation(original: LedgerAction.Node | undefined, sessionId: string) {
  if (original?.sessionId !== sessionId) return undefined;
  return intentInvocation(objectValue(original.intent.value));
}

function domainRevisionsAgree(
  recorded: PlainValue | undefined,
  expected: Readonly<Record<string, number>>,
): boolean {
  return recorded === undefined || canonicalDigest(recorded) === canonicalDigest(expected);
}

function originalInvocationMatches(
  next: SessionTransition.Request,
  snapshot: RequestSnapshot,
): boolean {
  const invocation = recordedInvocation(
    snapshot.actions.find((action) => action.id === next.requestId),
    snapshot.row.id,
  );
  if (invocation === undefined || invocation.value === undefined) return false;
  return all(
    canonicalDigest(invocation.value) === next.inputHash,
    canonicalDigest(next.parsedInput) === next.inputHash,
    invocation.effectHash === next.effectHash,
    domainRevisionsAgree(invocation.domainRevisions, next.domainRevisions),
  );
}

function generationMatches(request: SessionTransition.Request, row: LedgerSession.Row): boolean {
  return all(
    request.generation === row.policyGeneration,
    request.toolsGeneration === row.toolsGeneration,
    request.systemHash === row.systemHash,
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

function answerAddressed(
  answer: SessionTransition.Answer,
  command: SessionTransition.Command,
): boolean {
  return answer.sessionId === command.sessionId && answer.inputId === command.inputId;
}

function lateAnswer(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  const terminal = current.state === "open";
  const seen = withSeenReply(current, answer.inputId);
  const request: SessionTransition.Request = terminal
    ? { ...seen, state: "expired", outcome: "outcome_unknown" }
    : seen;
  return recordRequest(command, request, inputDigest, "late_unknown", terminal);
}

function replyOf(answer: SessionTransition.Answer): SessionTransition.Request["replies"][number] {
  return {
    replyId: answer.inputId,
    responderId: answer.principal.principalId,
    content: answer.content,
    receivedAt: answer.receivedAt,
  };
}

function settleReply(
  command: SessionTransition.Command,
  request: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  if (answer.decision === "refuse") {
    const refused: SessionTransition.Request = { ...request, state: "refused", outcome: "denied" };
    return recordRequest(command, refused, inputDigest, "refused", true);
  }
  if (request.replies.length >= request.threshold) {
    const resolved: SessionTransition.Request = {
      ...request,
      state: "resolved",
      outcome: "answered",
    };
    return recordRequest(command, resolved, inputDigest, "resolved", true);
  }
  return recordRequest(command, request, inputDigest, "attached");
}

function attachAnswer(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  const previouslySeen = current.seenReplyIds.includes(answer.inputId);
  const seen = withSeenReply(current, answer.inputId);
  if (
    seen.state !== "open" ||
    previouslySeen ||
    seen.replies.some((reply) => reply.responderId === answer.principal.principalId)
  )
    return recordRequest(command, seen, inputDigest, "duplicate");
  const replied = { ...seen, replies: [...seen.replies, replyOf(answer)] };
  return settleReply(command, replied, answer, inputDigest);
}

function answerRequest(
  command: SessionTransition.Command,
  snapshot: RequestSnapshot,
  current: SessionTransition.Request,
  answer: SessionTransition.Answer,
  inputDigest: string,
): RequestDecision {
  if (!answerAddressed(answer, command)) return rejected;
  if (answer.receivedAt >= current.deadline)
    return lateAnswer(command, current, answer, inputDigest);
  if (!answerBindingMatches(answer, current, snapshot))
    return recordRequest(command, current, inputDigest, "rejected");
  return attachAnswer(command, current, answer, inputDigest);
}

function withSeenReply(
  request: SessionTransition.Request,
  inputId: string,
): SessionTransition.Request {
  return { ...request, seenReplyIds: [...new Set([...request.seenReplyIds, inputId])] };
}

function principalValid(
  answer: SessionTransition.Answer,
  request: SessionTransition.Request,
): boolean {
  if (request.mode === "approval")
    return answer.principal.kind === "owner" && answer.decision !== "reply";
  return answer.decision !== "approve";
}

function answerBindingMatches(
  answer: SessionTransition.Answer,
  request: SessionTransition.Request,
  snapshot: RequestSnapshot,
): boolean {
  return all(
    principalValid(answer, request),
    request.expectedResponders.includes(answer.principal.principalId),
    answer.bindingDigest === request.bindingDigest,
    answer.inputHash === request.inputHash,
    answer.effectHash === request.effectHash,
    answer.generation === request.generation,
    answer.toolsHash === request.toolsHash,
    request.allowedActions.includes(answer.allowedAction),
    canonicalDigest(answer.domainRevisions) === canonicalDigest(request.domainRevisions),
    domainRevisionsMatch(request, snapshot.domainRevisions),
    generationMatches(request, snapshot.row),
  );
}

function domainRevisionsMatch(
  request: SessionTransition.Request,
  current: Readonly<Record<string, number>> | undefined,
): boolean {
  if (current === undefined) return Object.keys(request.domainRevisions).length === 0;
  return canonicalDigest({ ...current }) === canonicalDigest(request.domainRevisions);
}

function expireRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  inputDigest: string,
): RequestDecision {
  if (command.at < current.deadline) return rejected;
  const expired: SessionTransition.Request = {
    ...current,
    state: "expired",
    outcome: "outcome_unknown",
  };
  return recordRequest(command, expired, inputDigest, "expired", true);
}

function mayCancel(principal: SessionTransition.Principal, sessionId: string): boolean {
  return (
    principal.kind === "owner" ||
    (principal.kind === "session" && principal.principalId === sessionId)
  );
}

function cancelRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  principal: SessionTransition.Principal,
  inputDigest: string,
): RequestDecision {
  if (!mayCancel(principal, command.sessionId))
    return recordRequest(command, current, inputDigest, "rejected");
  const cancelled: SessionTransition.Request = {
    ...current,
    state: "cancelled",
    outcome: "cancelled",
  };
  return recordRequest(command, cancelled, inputDigest, "cancelled", true);
}

function closeRequest(
  command: SessionTransition.Command,
  current: SessionTransition.Request,
  payload: Extract<SessionTransition.Payload, { kind: "request.timeout" | "request.cancel" }>,
  inputDigest: string,
): RequestDecision {
  if (current.state !== "open") return recordRequest(command, current, inputDigest, "duplicate");
  if (payload.kind === "request.timeout") return expireRequest(command, current, inputDigest);
  return cancelRequest(command, current, payload.principal, inputDigest);
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
