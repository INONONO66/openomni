import {
  canonicalDigest,
  PlainObjectSchema,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  L0Observation,
  type PolicyRow,
  SessionGeneration,
  SessionHistory,
  SessionTransition,
  SessionTurn,
  type ObservationSink,
} from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import { Effect } from "effect";
import { StorageUnavailable, type LedgerError } from "../errors";
import type { CommitReceipt, LeaseReceipt } from "../services";
import { writeEffect } from "../storage/write-effect";

export const LEASE_TTL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const RESUME_BUDGET = 10;

interface MaterializeInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles?: readonly string[];
  readonly system: {
    readonly preset: string;
    readonly blocks: readonly SessionGeneration.SystemBlock[];
  };
  readonly policyGeneration: number;
  readonly actionId: string;
  readonly at: number;
}

export type ConfigureAuthority = (input: {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly operation: SessionGeneration.ConfigureIntent["operation"];
  readonly generation: number;
}) => boolean | Promise<boolean>;

export function materialize(
  input: MaterializeInput,
): Effect.Effect<LedgerSession.MaterializeResult, LedgerError> {
  return writeEffect("session.generation", () =>
    generationSnapshot({
      generation: 1,
      revertTo: 0,
      tools: input.tools,
      bundles: input.bundles,
      system: input.system,
      policyGeneration: input.policyGeneration,
    }),
  ).pipe(
    Effect.flatMap((snapshot) =>
      sessionWrites().pipe(
        Effect.flatMap((sessions) =>
          sessions.materialize({
            row: {
              id: input.id,
              parentId: input.parentId,
              role: input.role,
              leaseOwner: null,
              leaseFence: 0,
              leaseExpiresAt: null,
              revision: 0,
              state: "idle",
              toolsGeneration: snapshot.generation,
              systemHash: snapshot.systemHash,
              policyGeneration: snapshot.policyGeneration,
            },
            initialAction: configureAction({
              id: input.actionId,
              sessionId: input.id,
              parentId: null,
              operation: "create",
              snapshot,
              at: input.at,
            }),
          }),
        ),
      ),
    ),
  );
}

export function acquireLease(
  input: LedgerSession.AcquireLease,
): Effect.Effect<LeaseReceipt, LedgerError> {
  return sessionWrites().pipe(Effect.flatMap((sessions) => sessions.acquireLease(input)));
}

export function renewLease(input: LedgerSession.RenewLease): Effect.Effect<true, LedgerError> {
  return sessionWrites().pipe(Effect.flatMap((sessions) => sessions.renewLease(input)));
}

export function commit(input: LedgerSession.Commit): Effect.Effect<CommitReceipt, LedgerError> {
  return sessionWrites().pipe(Effect.flatMap((sessions) => sessions.commit(input)));
}

export function commitInbox(input: Inbox.Commit): Effect.Effect<Inbox.Row, LedgerError> {
  return inboxWrites().pipe(Effect.flatMap((inbox) => inbox.commit(input)));
}

export function commitReceivedMessage(input: Inbox.Commit): Effect.Effect<
  {
    row: Inbox.Row;
    receipt: LedgerAction.Receipt;
  },
  LedgerError
> {
  return inboxWrites().pipe(Effect.flatMap((inbox) => inbox.receive(input)));
}

export function pendingInbox(sessionId: string): Inbox.Row[] {
  return requiredInbox().list(sessionId, "pending");
}

export function inboxRows(sessionId: string): Inbox.Row[] {
  return requiredInbox().list(sessionId);
}

export function latestAction(
  sessionId: string,
  throughRevision = Number.MAX_SAFE_INTEGER,
): LedgerAction.Node | undefined {
  return requiredActions().latestAction(sessionId, throughRevision);
}

/** The seed and its high-water mark belong to the same SQLite read snapshot. */
export function latestFoldCheckpoint(sessionId: string, throughRevision?: number) {
  return Storage.get().transaction(() => {
    const revision = Math.min(row(sessionId).revision, throughRevision ?? Number.MAX_SAFE_INTEGER);
    return { revision, checkpoint: requiredActions().latestFoldCheckpoint(sessionId, revision) };
  });
}

export function priorModelAttempt(sessionId: string, turnId: string) {
  return requiredActions().priorModelAttempt(sessionId, turnId);
}

export function generationFor(
  sessionId: string,
  generation: number,
): SessionGeneration.Snapshot | undefined {
  return configurationSnapshot(requiredActions().generationFor(sessionId, generation));
}

export function turnTerminalFor(sessionId: string, turnId: string) {
  return turnTerminal(requiredActions().turnTerminalFor(sessionId, turnId));
}

export function latestTurnTerminal(sessionId: string) {
  const action = requiredActions().latestTurnTerminal(sessionId);
  const effect = turnTerminal(action);
  return action === undefined || effect === undefined ? undefined : { action, effect };
}

export function turnIntentsPage(sessionId: string, beforeRevision: number, limit = 256) {
  return requiredActions().turnIntentsPage(sessionId, beforeRevision, limit);
}

export function openTurnsPage(sessionId: string, cursor = 0, limit = 256): OpenTurn[] {
  const actions = requiredActions();
  return actions.openTurnsPage(sessionId, cursor, limit).flatMap((intent) => {
    const update = actions.latestTurnUpdate(sessionId, intent.id);
    return openTurns(update === undefined ? [intent] : [intent, update]);
  });
}

export function latestOpenTurn(sessionId: string): OpenTurn | undefined {
  let cursor = 0;
  let latest: OpenTurn | undefined;
  for (;;) {
    const page = openTurnsPage(sessionId, cursor);
    latest = page.at(-1) ?? latest;
    if (page.length < 256 || latest === undefined) return latest;
    const intent = actionById(latest.turnId);
    if (intent === undefined) throw new Error(`open turn intent missing: ${latest.turnId}`);
    cursor = intent.ordinal;
  }
}

export function resultFor(sessionId: string, parentId: string) {
  const result = requiredActions().resultFor(sessionId, parentId);
  if (result === undefined) return undefined;
  const parent = actionById(parentId);
  const outcome = SessionHistory.Outcome.safeParse(
    PlainObjectSchema.parse(result.effect.value).terminal,
  );
  if (
    parent?.sessionId !== sessionId ||
    parent.kind !== result.kind ||
    PlainObjectSchema.parse(result.intent.value).phase !== "result" ||
    !outcome.success ||
    outcome.data === "pending"
  )
    throw new Error(`invalid result identity: ${result.id}`);
  return result;
}

export function requestInputById(sessionId: string, inputId: string) {
  return requiredActions().requestInputById(sessionId, inputId);
}

export function guardedOperationsPage(sessionId: string, turnId: string, cursor = 0, limit = 256) {
  return requiredActions().guardedOperationsPage(sessionId, turnId, cursor, limit);
}

export function openOperationsPage(sessionId: string, turnId: string, cursor = 0, limit = 256) {
  return requiredActions().openOperationsPage(sessionId, turnId, cursor, limit);
}

export function operationChildrenPage(
  sessionId: string,
  parentId: string,
  cursor = 0,
  limit = 256,
) {
  return requiredActions().operationChildrenPage(sessionId, parentId, cursor, limit);
}

export function actionById(id: string): LedgerAction.Node | undefined {
  return requiredActions().actionById(id);
}

export function latestGenerationFor(sessionId: string): SessionGeneration.Snapshot {
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const action = requiredActions().configurationActions(sessionId, cursor)[0];
    if (action === undefined) throw new Error("session has no configured generation");
    const snapshot = configurationSnapshot(action);
    if (snapshot !== undefined) return snapshot;
    cursor = action.ordinal;
  }
}

/** inputHash is an exact persisted key, not a policy evaluation or JSON-path query API. */
export function policyDecisionRuleIds(sessionId: string, inputHash: string): string[] | undefined {
  return requiredActions().policyDecisionRuleIds(sessionId, inputHash);
}

export function messageActionByPlatformId(
  sessionId: string,
  messageId: string,
): LedgerAction.Node | undefined {
  return requiredActions().messageActionByPlatformId(sessionId, messageId);
}

export function outboundReceipt(
  destinationSessionId: string,
  messageId: string,
): LedgerAction.Receipt | undefined {
  return requiredActions().outboundReceipt(destinationSessionId, messageId);
}

export function verifyChain(sessionId: string): LedgerAction.ChainVerdict {
  return requiredActions().verifyChain(sessionId);
}

/**
 * Authoritative, bounded read of committed history after `afterRevision`. The
 * row revision and the slice come from one transaction, so a watcher that saw a
 * gap resynchronizes from its last revision without inventing or skipping events.
 */
export function historyPage(
  sessionId: string,
  request: SessionHistory.PageRequest = {},
): SessionHistory.Page {
  const { afterRevision, limit } = SessionHistory.PageRequest.parse(request);
  return Storage.get().transaction(() => {
    const headRevision = row(sessionId).revision;
    const actions = requiredActions().range(sessionId, afterRevision, limit);
    const last = actions.at(-1)?.ordinal ?? afterRevision;
    return SessionHistory.Page.parse({
      sessionId,
      afterRevision,
      headRevision,
      actions,
      nextRevision: last < headRevision ? last : null,
    });
  });
}

function stateEffect(action: LedgerAction.Node) {
  const effect = action.effect.value;
  if (effect === null || typeof effect !== "object" || Array.isArray(effect))
    throw new Error(`invalid ${action.kind === "outbound" ? "outbound" : "state"} action effect`);
  return effect;
}

export function requestStatesPage(sessionId?: string, cursor = "", limit = 256) {
  return requiredActions()
    .requestStatesPage(sessionId, cursor, limit)
    .map((action) => SessionTransition.Request.parse(stateEffect(action).request));
}

export function requestRows(sessionId?: string): SessionTransition.Request[] {
  const requests: SessionTransition.Request[] = [];
  let cursor = "";
  for (;;) {
    const page = requestStatesPage(sessionId, cursor);
    requests.push(...page);
    if (page.length < 256) return requests;
    cursor = page.at(-1)?.requestId ?? cursor;
  }
}

export function outboundStatesPage(sessionId: string, cursor = "", limit = 256) {
  return requiredActions()
    .outboundStatesPage(sessionId, cursor, limit)
    .map((action) => SessionTransition.Outbound.parse(stateEffect(action).outbound));
}

export function outboundRows(sessionId: string): SessionTransition.Outbound[] {
  const outbound: SessionTransition.Outbound[] = [];
  let cursor = "";
  for (;;) {
    const page = outboundStatesPage(sessionId, cursor);
    outbound.push(...page);
    if (page.length < 256) return outbound;
    cursor = page.at(-1)?.message.messageId ?? cursor;
  }
}

export function requestById(requestId: string): SessionTransition.Request | undefined {
  const action = requiredActions().requestStateById(requestId);
  return action === undefined
    ? undefined
    : SessionTransition.Request.parse(stateEffect(action).request);
}

export function commitRequestTransition(
  input: LedgerSession.Commit,
): Effect.Effect<CommitReceipt, LedgerError> {
  return commit(input);
}

export function row(sessionId: string): LedgerSession.Row {
  const current = requiredSessions().get(sessionId);
  if (current === undefined) throw new Error(`session not found: ${sessionId}`);
  return current;
}

export function listRows(): LedgerSession.Row[] {
  return requiredSessions().list();
}

export function openChildCount(parentId: string): number {
  return requiredSessions().openChildCount(parentId);
}

export function policyRows(generation?: number): PolicyRow.Row[] {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("L0 storage capability is unavailable: policies");
  return policies.rows(generation);
}

export function currentPolicyGeneration(): number {
  return policyRows().reduce((latest, policy) => Math.max(latest, policy.generation), 0);
}

export function latestGeneration(
  actions: readonly LedgerAction.Node[],
): SessionGeneration.Snapshot {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const snapshot = configurationSnapshot(actions[index]);
    if (snapshot !== undefined) return snapshot;
  }
  throw new Error("session has no configured generation");
}

export function generationByNumber(
  actions: readonly LedgerAction.Node[],
  generation: number,
): SessionGeneration.Snapshot | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const snapshot = configurationSnapshot(actions[index]);
    if (snapshot?.generation === generation) return snapshot;
  }
  return undefined;
}

export function generationSnapshot(input: {
  readonly generation: number;
  readonly revertTo: number;
  readonly tools: readonly SessionGeneration.Tool[];
  readonly bundles?: readonly string[];
  readonly system: {
    readonly preset: string;
    readonly blocks: readonly SessionGeneration.SystemBlock[];
  };
  readonly policyGeneration: number;
}): SessionGeneration.Snapshot {
  assertUniqueTools(input.tools);
  assertUniqueBlocks(input.system.blocks);
  const tools = [...input.tools].sort((left, right) => left.name.localeCompare(right.name));
  const blocks = [...input.system.blocks];
  return SessionGeneration.Snapshot.parse({
    generation: input.generation,
    revertTo: input.revertTo,
    tools,
    toolsHash: canonicalDigest(tools),
    bundles: [...(input.bundles ?? [])].sort(),
    systemPreset: input.system.preset,
    systemBlocks: blocks,
    systemValue: [input.system.preset, ...blocks.map((block) => block.content)]
      .filter((value) => value.length > 0)
      .join("\n\n"),
    systemHash: canonicalDigest(blocks),
    policyGeneration: input.policyGeneration,
  });
}

export function configureAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly operation: SessionGeneration.ConfigureIntent["operation"];
  readonly snapshot: SessionGeneration.Snapshot;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: "session.configure",
    intent: {
      encodingVersion: 1,
      value: { operation: input.operation },
    },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "configured",
        snapshot: { ...input.snapshot, bundles: [...input.snapshot.bundles] },
      },
    },
    revert: {
      encodingVersion: 1,
      value: { generation: input.snapshot.revertTo },
    },
    ts: input.at,
  };
}

export function turnIntent(
  action: LedgerAction.Node | undefined,
): SessionTurn.DecodeIntent | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.DecodeIntent.safeParse(action.intent.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnResume(
  action: LedgerAction.Node | undefined,
): SessionTurn.DecodeResume | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.DecodeResume.safeParse(action.intent.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnCheckpoint(
  action: LedgerAction.Node | undefined,
): SessionTurn.Checkpoint | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.Checkpoint.safeParse(action.effect.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnTerminal(
  action: LedgerAction.Node | undefined,
): SessionTurn.Terminal | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.Terminal.safeParse(action.effect.value);
  return parsed.success ? parsed.data : undefined;
}

export function delivery(action: LedgerAction.Node | undefined): SessionTurn.Delivery | undefined {
  if (action?.kind !== "inbox.deliver") return undefined;
  const parsed = SessionTurn.Delivery.safeParse(action.effect.value);
  return parsed.success ? parsed.data : undefined;
}

export interface OpenTurn {
  readonly turnId: string;
  readonly resultId: string;
  readonly resumeCount: number;
  readonly boundaryActionId: string | null;
  readonly toolsGeneration: number;
  readonly toolsHash: string;
  readonly systemHash: string;
  readonly policyGeneration: number;
  readonly action: LedgerAction.Node;
}

export function openTurns(actions: readonly LedgerAction.Node[]): OpenTurn[] {
  const opened = new Map<string, OpenTurn>();
  for (const action of actions) {
    const intent = turnIntent(action);
    if (intent !== undefined) {
      opened.set(action.id, {
        turnId: action.id,
        resultId: intent.resultId,
        resumeCount: intent.resumeCount,
        boundaryActionId: intent.boundaryActionId,
        toolsGeneration: intent.toolsGeneration,
        toolsHash: intent.toolsHash,
        systemHash: intent.systemHash,
        policyGeneration: intent.policyGeneration,
        action,
      });
      continue;
    }
    const resume = turnResume(action);
    if (resume !== undefined) {
      const current = opened.get(resume.turnId);
      if (current !== undefined) {
        opened.set(resume.turnId, {
          ...current,
          resultId: resume.resultId,
          resumeCount: resume.resumeCount,
          boundaryActionId: resume.boundaryActionId,
          toolsGeneration: resume.toolsGeneration,
          toolsHash: resume.toolsHash,
          systemHash: resume.systemHash,
          policyGeneration: resume.policyGeneration,
          action,
        });
      }
      continue;
    }
    const checkpoint = turnCheckpoint(action);
    if (checkpoint !== undefined) {
      const current = opened.get(checkpoint.turnId);
      if (current !== undefined) {
        opened.set(checkpoint.turnId, {
          ...current,
          resultId: checkpoint.resultId,
          resumeCount: checkpoint.resumeCount,
          boundaryActionId: checkpoint.boundaryActionId,
          action,
        });
      }
      continue;
    }
    const terminal = turnTerminal(action);
    if (terminal !== undefined) opened.delete(terminal.turnId);
  }
  return [...opened.values()];
}

export function getSnapshot(sessionId: string, turns = 1): SessionTurn.Snapshot {
  if (!Number.isInteger(turns) || turns < 0) throw new Error("turn count must be non-negative");
  return Storage.get().transaction(() => snapshotFor(row(sessionId), turns));
}

function snapshotFor(current: LedgerSession.Row, turns: number): SessionTurn.Snapshot {
  const sessionId = current.id;
  void latestGenerationFor(sessionId);
  const open = latestOpenTurn(sessionId);
  return SessionTurn.Snapshot.parse({
    id: current.id,
    parentId: current.parentId,
    role: current.role,
    revision: current.revision,
    state: current.state,
    lease: {
      owner: current.leaseOwner,
      fence: current.leaseFence,
      expiresAt: current.leaseExpiresAt,
    },
    toolsGeneration: current.toolsGeneration,
    systemHash: current.systemHash,
    policyGeneration: current.policyGeneration,
    ...(open === undefined ? {} : { openTurnId: open.turnId }),
    turns: turnTails(sessionId, current.revision, turns),
  });
}

export function watchSnapshot(
  sessionId: string,
  turns: number,
  observations: ObservationSink,
): SessionTurn.Watch {
  const subscribeObservation = observations.subscribe;
  if (subscribeObservation === undefined) {
    throw new Error("session watch requires a subscribable observation sink");
  }
  return Storage.get().transaction(() => {
    let revision = 0;
    let closed = false;
    const handlers = new Set<(observation: SessionTurn.Observation) => void>();
    const stop = subscribeObservation(
      L0Observation.ActionCommittedEvent,
      (event) => {
        const observation: SessionTurn.Observation =
          event.revision > revision + 1
            ? { kind: "gap", sessionId, from: revision, to: event.revision }
            : {
                kind: "revision",
                sessionId,
                revision: event.revision,
                actionId: event.id,
                actionKind: event.kind,
              };
        revision = event.revision;
        for (const handler of [...handlers]) handler(observation);
      },
      { match: { sessionId } },
    );
    let snapshot: SessionTurn.Snapshot | undefined;
    try {
      snapshot = getSnapshot(sessionId, turns);
    } finally {
      if (snapshot === undefined) stop();
    }
    revision = snapshot.revision;
    return {
      snapshot,
      subscribe(handler: (observation: SessionTurn.Observation) => void) {
        if (closed) throw new Error("session watch is unsubscribed");
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      unsubscribe() {
        if (closed) return;
        closed = true;
        handlers.clear();
        stop();
      },
    };
  });
}

function configurationSnapshot(
  action: LedgerAction.Node | undefined,
): SessionGeneration.Snapshot | undefined {
  if (action?.kind !== "session.configure") return undefined;
  const effect = SessionGeneration.ConfigureEffect.safeParse(action.effect.value);
  return effect.success ? effect.data.snapshot : undefined;
}

function turnTails(sessionId: string, revision: number, count: number): SessionTurn.Tail[] {
  const tails: SessionTurn.Tail[] = [];
  let cursor = revision + 1;
  while (tails.length < count) {
    const intents = requiredActions().turnIntentsPage(
      sessionId,
      cursor,
      Math.min(256, count - tails.length),
    );
    for (const intent of intents) tails.push(turnTail(intent));
    if (intents.length === 0) break;
    cursor = intents.at(-1)?.ordinal ?? cursor;
  }
  return tails.reverse();
}

function turnTail(intent: LedgerAction.Node): SessionTurn.Tail {
  const actions = requiredActions();
  const messages: SessionTurn.Message[] = [];
  let cursor = 0;
  for (;;) {
    const page = actions.turnDeliveriesPage(intent.sessionId, intent.id, cursor, 256);
    for (const action of page) {
      const delivered = delivery(action);
      if (delivered?.kind === "prompt") messages.push({ role: "user", text: delivered.content });
    }
    if (page.length < 256) break;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
  const action = actions.turnTerminalFor(intent.sessionId, intent.id);
  const terminal = turnTerminal(action);
  if (terminal !== undefined && terminal.text.length > 0)
    messages.push({ role: "assistant", text: terminal.text });
  return {
    turnId: intent.id,
    startedAt: intent.ts,
    state:
      terminal === undefined ? "running" : terminal.kind === "interrupted" ? "interrupted" : "idle",
    messages,
    ...(terminal === undefined || action === undefined
      ? {}
      : {
          terminal: { kind: terminal.kind, actionId: action.id, at: action.ts },
        }),
  };
}

function assertUniqueTools(tools: readonly SessionGeneration.Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new SessionGeneration.ConfigureError({
        code: "duplicate_tool",
        message: `duplicate tool name: ${tool.name}`,
      });
    }
    seen.add(tool.name);
  }
}

function assertUniqueBlocks(blocks: readonly SessionGeneration.SystemBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) {
      throw new SessionGeneration.ConfigureError({
        code: "duplicate_block",
        message: `duplicate system block id: ${block.id}`,
      });
    }
    seen.add(block.id);
  }
}

function sessionWrites() {
  return writeEffect("storage.sessions", (refuse) => {
    if (Storage.getInitializedDbPath() === null)
      return refuse(new StorageUnavailable({ capability: "storage" }));
    const sessions = Storage.get().sessions;
    if (sessions === undefined) return refuse(new StorageUnavailable({ capability: "sessions" }));
    return sessions;
  });
}

function inboxWrites() {
  return writeEffect("storage.inbox", (refuse) => {
    if (Storage.getInitializedDbPath() === null)
      return refuse(new StorageUnavailable({ capability: "storage" }));
    const inbox = Storage.get().inbox;
    if (inbox === undefined) return refuse(new StorageUnavailable({ capability: "inbox" }));
    return inbox;
  });
}

function requiredSessions() {
  const adapter = Storage.get().sessions;
  if (adapter === undefined) throw new Error("L0 storage capability is unavailable: sessions");
  return adapter;
}

function requiredActions() {
  const adapter = Storage.get().actions;
  if (adapter === undefined) throw new Error("L0 storage capability is unavailable: actions");
  return adapter;
}

function requiredInbox() {
  const adapter = Storage.get().inbox;
  if (adapter === undefined) throw new Error("L0 storage capability is unavailable: inbox");
  return adapter;
}
