import {
  Alarm,
  canonicalDigest,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  L0Observation,
  type PolicyRow,
  SessionGeneration,
  SessionTurn,
  type ObservationSink,
} from "@openomni/protocol";
import { Storage } from "../storage/storage.js";

export const LEASE_TTL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const RESUME_BUDGET = 10;

export interface MaterializeInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: LedgerSession.Role;
  readonly tools: readonly SessionGeneration.Tool[];
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

export function materialize(input: MaterializeInput): LedgerSession.MaterializeResult {
  const snapshot = generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: input.tools,
    system: input.system,
    policyGeneration: input.policyGeneration,
  });
  const result = requiredSessions().materialize({
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
  });
  if (result === undefined) throw new Error(`session materialization refused: ${input.id}`);
  return result;
}

export function acquireLease(input: LedgerSession.AcquireLease): LedgerSession.LeaseResult {
  const result = requiredSessions().acquireLease(input);
  if (result === undefined) throw new Error(`session not found: ${input.sessionId}`);
  return result;
}

export function renewLease(input: LedgerSession.RenewLease): boolean {
  return requiredSessions().renewLease(input);
}

export function commit(input: LedgerSession.Commit): LedgerSession.CommitResult {
  const result = requiredSessions().commit(input);
  if (result === undefined) throw new Error(`session not found: ${input.sessionId}`);
  return result;
}

export function commitInbox(input: Inbox.Commit): Inbox.Row {
  const committed = requiredInbox().commit(input);
  if (committed === undefined) throw new Error(`inbox commit refused: ${input.id}`);
  return committed;
}

export function armMessageDeadline(input: {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sourceActionId: string;
  readonly fireAt: number;
  readonly createdAt: number;
  readonly replyTo?: string;
}): Alarm.Row {
  const sender = row(input.sessionId);
  const spec = Alarm.MessageDeadline.parse({
    kind: "message_deadline",
    messageId: input.messageId,
    sourceActionId: input.sourceActionId,
    createdAt: input.createdAt,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    generation: {
      toolsGeneration: sender.toolsGeneration,
      systemHash: sender.systemHash,
      policyGeneration: sender.policyGeneration,
    },
  });
  const alarm = requiredAlarms().arm({
    id: `${input.sourceActionId}:deadline`, sessionId: input.sessionId,
    kind: "at", fireAt: input.fireAt, spec: { encodingVersion: 1, value: spec },
  });
  if (alarm === undefined) throw new Error(`message deadline arm refused: ${input.messageId}`);
  return alarm;
}

/** Called by the alarm owner at a supplied instant, never a second timer loop. */
export function expireMessageDeadlines(at: number): readonly string[] {
  const sessions = new Set<string>();
  const alarms = requiredAlarms();
  for (const alarm of alarms.due(at)) {
    if (!Alarm.MessageDeadline.safeParse(alarm.spec?.value).success) continue;
    const timeout = alarms.fireMessage(alarm.id, at);
    if (timeout !== undefined) sessions.add(timeout.sessionId);
  }
  return [...sessions];
}

export function pendingInbox(sessionId: string): Inbox.Row[] {
  return requiredInbox().list(sessionId, "pending");
}

export function inboxRows(sessionId: string): Inbox.Row[] {
  return requiredInbox().list(sessionId);
}

export function tree(sessionId: string): LedgerAction.Node[] {
  return requiredActions().tree(sessionId);
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
      value: SessionGeneration.ConfigureIntent.parse({ operation: input.operation }),
    },
    effect: {
      encodingVersion: 1,
      value: SessionGeneration.ConfigureEffect.parse({
        phase: "configured",
        snapshot: input.snapshot,
      }),
    },
    revert: {
      encodingVersion: 1,
      value: SessionGeneration.ConfigureRevert.parse({ generation: input.snapshot.revertTo }),
    },
    ts: input.at,
  };
}

export function turnIntent(action: LedgerAction.Node | undefined): SessionTurn.Intent | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.Intent.safeParse(action.intent.value);
  return parsed.success ? parsed.data : undefined;
}

export function turnResume(action: LedgerAction.Node | undefined): SessionTurn.Resume | undefined {
  if (action?.kind !== "turn") return undefined;
  const parsed = SessionTurn.Resume.safeParse(action.intent.value);
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
  const current = row(sessionId);
  const actions = tree(sessionId);
  const open = openTurns(actions).at(-1);
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
    turns: turns === 0 ? [] : foldTurnTails(actions).slice(-turns),
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
    let snapshot: SessionTurn.Snapshot;
    try {
      snapshot = getSnapshot(sessionId, turns);
    } catch (error) {
      stop();
      throw error;
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

function foldTurnTails(actions: readonly LedgerAction.Node[]): SessionTurn.Tail[] {
  const tails = new Map<string, SessionTurn.Tail>();
  const pendingMessages: SessionTurn.Message[] = [];
  for (const action of actions) {
    const delivered = delivery(action);
    if (delivered?.kind === "prompt") {
      const tail = tails.get(delivered.turnId);
      const message = SessionTurn.Message.parse({ role: "user", text: delivered.content });
      if (tail === undefined) pendingMessages.push(message);
      else tails.set(delivered.turnId, { ...tail, messages: [...tail.messages, message] });
      continue;
    }
    const intent = turnIntent(action);
    if (intent !== undefined) {
      tails.set(action.id, {
        turnId: action.id,
        state: "running",
        startedAt: action.ts,
        messages: pendingMessages.splice(0),
      });
      continue;
    }
    const terminal = turnTerminal(action);
    if (terminal === undefined) continue;
    const tail = tails.get(terminal.turnId);
    if (tail === undefined) continue;
    tails.set(terminal.turnId, {
      ...tail,
      state: terminal.kind === "interrupted" ? "interrupted" : "idle",
      terminal: { kind: terminal.kind, actionId: action.id, at: action.ts },
      ...(terminal.text.length === 0
        ? {}
        : { messages: [...tail.messages, { role: "assistant", text: terminal.text }] }),
    });
  }
  return [...tails.values()];
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

function requiredAlarms() {
  const adapter = Storage.get().alarms;
  if (adapter === undefined) throw new Error("L0 storage capability is unavailable: alarms");
  return adapter;
}

function requiredInbox() {
  const adapter = Storage.get().inbox;
  if (adapter === undefined) throw new Error("L0 storage capability is unavailable: inbox");
  return adapter;
}
