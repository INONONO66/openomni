import { SessionHandleStore } from "@openomni/ledger";
import {
  SessionGeneration,
  SessionTurn,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type PlainValue,
  type PlainObject,
} from "@openomni/protocol";
import { RunReasonCode } from "./core/policy/reason-codes";
import {
  SessionCommitError,
  SessionPolicyRefusal,
  type SessionRunnerResult,
  type SessionTool,
} from "./session-contract";

export function latestTerminal(
  actions: readonly LedgerAction.Node[],
): { readonly action: LedgerAction.Node; readonly effect: SessionTurn.Terminal } | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    const effect = SessionHandleStore.turnTerminal(action);
    if (action !== undefined && effect !== undefined) return { action, effect };
  }
  return undefined;
}

export function sessionMessages(
  actions: readonly LedgerAction.Node[],
): (SessionTurn.Message & { readonly id: string })[] {
  const messages: (SessionTurn.Message & { readonly id: string })[] = [];
  for (const action of actions) {
    const delivered = SessionHandleStore.delivery(action);
    if (delivered?.kind === "prompt") {
      messages.push({ id: delivered.inboxId, role: "user", text: delivered.content });
    }
    const terminal = SessionHandleStore.turnTerminal(action);
    if (terminal !== undefined && terminal.text.length > 0) {
      messages.push({ id: action.id, role: "assistant", text: terminal.text });
    }
  }
  return messages;
}

export function toolSnapshot(tool: SessionTool): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse(tool);
}

export function internalOrigin(sessionId: string): Inbox.Origin {
  return { encodingVersion: 1, value: { kind: "session", id: sessionId } };
}

export function requireCommit(result: LedgerSession.CommitResult): LedgerSession.Row {
  if (!result.ok) throw new SessionCommitError(result);
  return result.row;
}

interface TurnEnvelopeActionInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly at: number;
}

interface TurnPinnedInput {
  readonly generation: SessionGeneration.Snapshot;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
}

function pinnedTurn(input: TurnPinnedInput): Omit<SessionTurn.Intent, "phase" | "inboxIds"> {
  return {
    resultId: input.resultId,
    toolsGeneration: input.generation.generation,
    toolsHash: input.generation.toolsHash,
    systemHash: input.generation.systemHash,
    policyGeneration: input.generation.policyGeneration,
    resumeCount: input.resumeCount,
    boundaryActionId: input.boundaryActionId,
  };
}

function turnEnvelopeAction(
  input: TurnEnvelopeActionInput,
  intent: SessionTurn.Intent | SessionTurn.Resume,
): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: intent },
    effect: { encodingVersion: 1, value: SessionTurn.Pending.parse({ phase: "pending" }) },
    irreversible: true,
    ts: input.at,
  };
}

export function turnIntentAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly resultId: string;
  readonly inboxIds: readonly string[];
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.Intent.parse({
      phase: "intent",
      inboxIds: [...input.inboxIds],
      ...pinnedTurn(input),
    }),
  );
}

export function turnResumeAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly generation: SessionGeneration.Snapshot;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return turnEnvelopeAction(
    input,
    SessionTurn.Resume.parse({
      phase: "resume",
      turnId: input.turnId,
      ...pinnedTurn(input),
    }),
  );
}

export function turnCheckpointAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string;
  readonly boundary: SessionTurn.Boundary;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "checkpoint", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "checkpoint",
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: input.resumeCount,
        boundaryActionId: input.boundaryActionId,
        boundary: input.boundary,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

export function deliveryActions(
  items: readonly Inbox.Row[],
  turnId: string,
  boundary: SessionTurn.Boundary,
  parentId: string | null,
): LedgerAction.Append[] {
  let parent = parentId;
  return items.map((item) => {
    const action: LedgerAction.Append = {
      id: `${item.id}:delivery`,
      parentId: parent,
      sessionId: item.sessionId,
      kind: "inbox.deliver",
      intent: { encodingVersion: 1, value: { inboxId: item.id } },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "delivery",
          turnId,
          inboxId: item.id,
          kind: item.kind,
          content: item.content,
          origin: item.origin,
          boundary,
        },
      },
      irreversible: true,
      ts: item.createdAt,
    };
    parent = action.id;
    return action;
  });
}

export function turnTerminalAction(input: {
  readonly id: string;
  readonly parentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: SessionRunnerResult;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId: input.turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "terminal",
        turnId: input.turnId,
        kind: input.result.kind,
        ...(input.result.kind === "waiting"
          ? { reason: input.result.reason, alarmIds: [...input.result.alarmIds] }
          : {}),
        text: input.result.text ?? "",
        boundaryActionId: input.boundaryActionId,
        resumeCount: input.resumeCount,
      },
    },
    irreversible: true,
    ts: input.at,
  };
}

export function policyRefusalResult(reason: string): SessionRunnerResult {
  const cause = new SessionPolicyRefusal(reason);
  return { kind: "error", text: cause.message, cause };
}

export function sessionRunnerResultValue(result: SessionRunnerResult): PlainValue {
  if (result.kind === "waiting") return { ...result, alarmIds: [...result.alarmIds] };
  if (result.kind === "interrupted") {
    return { kind: result.kind, ...(result.text === undefined ? {} : { text: result.text }) };
  }
  if (result.kind === "error") {
    return {
      kind: result.kind,
      text: result.text,
      ...(result.reported === undefined ? {} : { reported: result.reported }),
    };
  }
  return {
    kind: result.kind,
    text: result.text,
    ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
    ...(result.usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            ...(result.usage.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: result.usage.reasoningTokens }),
            ...(result.usage.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: result.usage.cacheReadTokens }),
            ...(result.usage.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: result.usage.cacheWriteTokens }),
          },
        }),
  };
}

export function sessionRunnerResultFromValue(value: PlainValue): SessionRunnerResult | undefined {
  if (!plainObject(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "interrupted") {
    if (!onlyKeys(value, ["kind", "text"])) return undefined;
    if ("text" in value && typeof value.text !== "string") return undefined;
    return { kind: "interrupted", ...(typeof value.text === "string" ? { text: value.text } : {}) };
  }
  if (value.kind === "error") {
    if (!onlyKeys(value, ["kind", "text", "reported"]) || typeof value.text !== "string") {
      return undefined;
    }
    if ("reported" in value && value.reported !== true) return undefined;
    return {
      kind: "error",
      text: value.text,
      ...(value.reported === true ? { reported: true as const } : {}),
    };
  }
  if (value.kind === "waiting") {
    if (
      !onlyKeys(value, ["kind", "text", "reason", "alarmIds"]) ||
      typeof value.text !== "string" ||
      value.reason !== "live_wait" ||
      !Array.isArray(value.alarmIds) ||
      value.alarmIds.length === 0 ||
      !value.alarmIds.every((id) => typeof id === "string")
    )
      return undefined;
    return {
      kind: "waiting",
      text: value.text,
      reason: "live_wait",
      alarmIds: value.alarmIds.filter((id): id is string => typeof id === "string"),
    };
  }
  if (value.kind !== "result") return undefined;
  if (!onlyKeys(value, ["kind", "text", "finishReason", "usage"])) return undefined;
  if (typeof value.text !== "string") return undefined;
  const finishReason = value.finishReason;
  if (
    finishReason !== undefined &&
    finishReason !== "stop" &&
    finishReason !== "max-steps" &&
    finishReason !== RunReasonCode.Stalled
  ) {
    return undefined;
  }
  const usage = value.usage === undefined ? undefined : sessionUsageFromValue(value.usage);
  if (value.usage !== undefined && usage === undefined) return undefined;
  return {
    kind: "result",
    text: value.text,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
  };
}

type SessionUsage = NonNullable<Extract<SessionRunnerResult, { readonly kind: "result" }>["usage"]>;

function sessionUsageFromValue(value: PlainValue): SessionUsage | undefined {
  if (
    !plainObject(value) ||
    !onlyKeys(value, [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ])
  ) {
    return undefined;
  }
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = value.totalTokens;
  if (!finiteNumber(inputTokens) || !finiteNumber(outputTokens) || !finiteNumber(totalTokens)) {
    return undefined;
  }
  const reasoningTokens = optionalFiniteNumber(value, "reasoningTokens");
  const cacheReadTokens = optionalFiniteNumber(value, "cacheReadTokens");
  const cacheWriteTokens = optionalFiniteNumber(value, "cacheWriteTokens");
  if (reasoningTokens === false || cacheReadTokens === false || cacheWriteTokens === false) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function optionalFiniteNumber(value: PlainObject, key: string): number | undefined | false {
  if (!(key in value)) return undefined;
  const candidate = value[key];
  return finiteNumber(candidate) ? candidate : false;
}

function finiteNumber(value: PlainValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function plainObject(value: PlainValue): value is PlainObject {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function onlyKeys(value: PlainObject, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function generationForOpen(open: SessionHandleStore.OpenTurn): SessionGeneration.Snapshot {
  const snapshot = SessionHandleStore.generationByNumber(
    SessionHandleStore.tree(open.action.sessionId),
    open.toolsGeneration,
  );
  if (
    snapshot === undefined ||
    snapshot.toolsHash !== open.toolsHash ||
    snapshot.systemHash !== open.systemHash ||
    snapshot.policyGeneration !== open.policyGeneration
  ) {
    throw new Error(`pinned session generation unavailable: ${open.toolsGeneration}`);
  }
  return snapshot;
}
