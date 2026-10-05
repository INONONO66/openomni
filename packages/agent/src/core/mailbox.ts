import { Effect } from "effect";
import { CommitRefused, type LedgerError } from "./store/errors";
import * as SessionHandleStore from "./store/fence";
import type { CommitReceipt } from "./store/services";
import { ObservationSink, type RunnerServices } from "./ports";
import { canonicalDigest, Journal, PlainValueSchema, type SessionGeneration, type Inbox, type LedgerAction, type LedgerSession, type PlainValue, } from "@openomni/protocol";
import { createExecutor, type ExecutionResult } from "./gate/decide";
import { recordedCompaction, requireCompactionIntent, restoreContextRequest, restoredContextProjection } from "../plugins/compaction/restore";
import { AgentFailure, CommitFailed, type ExecutionError, type SessionError } from "./failure";
import { SessionPolicyRefusal } from "./messages";
import type { ResolvedSessionRuntime, SessionRunnerResult, SessionActionCommitPort } from "./run";
import type { SessionKernel } from "./entity";
import { turnIntentAction, turnResumeAction, deliveryActions, inputRowKind, policyRefusalResult, generationForOpen, pendingBacklog, boundaryConsumption, consumptionSettings, } from "./commit";
import type { SessionControllerState } from "./run";
import { observeDrained } from "./bus";
import { commitSessionRequest } from "./request";
export { commitSessionRequest } from "./request";

import { commitFoldBatch } from "./commit";
import { hydrateSessionHistory } from "../inspect/history";

type AdmissionError = SessionError;

/**
 * The capability journal kinds the kernel composes built-in (#1252): `tool`
 * and `compaction` ship with the core loop; `action` arrives with its plugin.
 */
const BUILTIN_CAPABILITY_KINDS: readonly string[] = Object.freeze(["tool", "compaction"]);

interface AdmissionSnapshot {
  readonly row: LedgerSession.Row;
  readonly pending: readonly Inbox.Row[];
  readonly open?: SessionHandleStore.OpenTurn;
  readonly terminal?: ReturnType<SessionKernel["latestTurnTerminal"]>;
  /** Capability kinds the composed generation registers; defaults to the built-ins. */
  readonly capabilityKinds?: readonly string[];
}

type AdmissionDecision =
  | { readonly kind: "stop" | "start" }
  | { readonly kind: "refused"; readonly reason?: "unknown_kind" }
  | { readonly kind: "recover"; readonly open: SessionHandleStore.OpenTurn }
  | { readonly kind: "resume"; readonly item: Inbox.Row }
  | { readonly kind: "consume"; readonly items: readonly Inbox.Row[] };

/** Pure routing of the durable S/T/I views; dispatch remains behind the ledger CAS. */
export function decideSessionAdmission(snapshot: AdmissionSnapshot): AdmissionDecision {
  const { row, pending, open, terminal } = snapshot;
  // #1252 input admission: an input whose journal row kind belongs to a
  // capability absent from the composed generation is rejected, not consumed.
  const registered = snapshot.capabilityKinds ?? BUILTIN_CAPABILITY_KINDS;
  if (pending.some((item) => Journal.admitInputKind(registered, inputRowKind(item.kind)) !== "ok"))
    return { kind: "refused", reason: "unknown_kind" };
  if (pending.some((item) => item.sessionId !== row.id || item.status !== "pending")) return { kind: "refused" };
  if (open !== undefined && open.action.sessionId !== row.id) return { kind: "refused" };
  if (terminal !== undefined && terminal.action.sessionId !== row.id) return { kind: "refused" };
  switch (row.state) {
    case "running":
      return open === undefined ? { kind: "refused" } : { kind: "recover", open };
    case "interrupted": {
      if (open !== undefined) return { kind: "recover", open };
      const item = pending.find((input) => input.kind === "resume");
      if (item === undefined) return { kind: "stop" };
      return terminal?.effect.kind === "interrupted"
        ? { kind: "resume", item }
        : { kind: "consume", items: [item] };
    }
    case "idle":
      return open === undefined ? decideIdleInbox(pending) : { kind: "refused" };
  }
}

function decideIdleInbox(pending: readonly Inbox.Row[]): AdmissionDecision {
  if (pending.length === 0) return { kind: "stop" };
  const firstPrompt = pending.findIndex((item) => item.kind === "prompt");
  if (firstPrompt === 0) return { kind: "start" };
  return { kind: "consume", items: firstPrompt > 0 ? pending.slice(0, firstPrompt) : pending };
}

export function createSessionAdmission(
  kernel: SessionKernel,
  sessionId: string,
  runtime: ResolvedSessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  ports: {
    readonly awaitRetainedRunner: () => Effect.Effect<void, AdmissionError>;
    readonly runTurn: (input: {
      readonly turnId: string;
      readonly resultId: string;
      readonly parentActionId: string;
      readonly boundaryActionId: string | null;
      readonly resumeCount: number;
      readonly generation: SessionGeneration.Snapshot;
      readonly resume: boolean;
    }) => Effect.Effect<SessionRunnerResult, AdmissionError>;
    readonly seal: (
      open: SessionHandleStore.OpenTurn,
      result: SessionRunnerResult,
    ) => Effect.Effect<void, AdmissionError>;
  },
) {
  const { awaitRetainedRunner, runTurn, seal } = ports;

  function commitSession(input: {
    readonly expectedRevision: number;
    readonly actions: readonly LedgerAction.Append[];
    readonly state: LedgerSession.State;
    readonly generation?: LedgerSession.GenerationPointers;
  }): Effect.Effect<CommitReceipt, LedgerError> {
    return commitFoldBatch(kernel, {
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: input.expectedRevision,
      actions: [...input.actions],
      state: input.state,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    });
  }

  /**
   * Turn-start manifest adoption (#1255): when the product's composed
   * generation differs from the session's adopted `manifestHash`, append one
   * `session.configure{operation: "compose", disabled}` through the single
   * writer, then capture. The in-flight turn never sees this — it finishes on
   * the generation it captured; rotation happens strictly between turns.
   */
  function adoptComposedManifest(): Effect.Effect<void, AdmissionError> {
    return Effect.gen(function* () {
      const composed = runtime.composed?.current();
      if (composed === undefined) return;
      const previous = kernel.latestGenerationFor(sessionId);
      if (previous.manifestHash === composed.hash) return;
      const generation = previous.generation + 1;
      const snapshot = SessionHandleStore.generationSnapshot({
        generation,
        revertTo: previous.generation,
        tools: composed.tools,
        system: { preset: previous.systemPreset, blocks: previous.systemBlocks },
        policyGeneration: previous.policyGeneration,
        bundles: composed.bundles,
        manifestHash: composed.hash,
      });
      const configured = SessionHandleStore.configureAction({
        id: entropy(),
        sessionId,
        parentId: kernel.latestAction(sessionId)?.id ?? null,
        operation: "compose",
        snapshot,
        disabled: composed.disabled,
        at: clock(),
      });
      const commit = commitSession({
        expectedRevision: kernel.row(sessionId).revision,
        actions: [configured],
        state: kernel.row(sessionId).state,
        generation: {
          toolsGeneration: snapshot.generation,
          systemHash: snapshot.systemHash,
          policyGeneration: snapshot.policyGeneration,
        },
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      yield* runtime.generations.configure({ sessionId, generation }, snapshot, commit);
    });
  }

  function startTurn(): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.scoped(Effect.gen(function* () {
      yield* awaitRetainedRunner();
      yield* adoptComposedManifest();
      const generation = kernel.latestGenerationFor(sessionId);
      const captured = yield* runtime.generations.capture({ sessionId, generation: generation.generation });
      const observations = yield* captured.provide(ObservationSink);
      // #1253 turn end: both steer and followUp rows are eligible, each capped
      // by its settings width; the leftover backlog feeds the next turn.
      // #1256 H-3/H-1: the stale split lives INSIDE boundaryConsumption — a
      // deferred `action` input pointing before the compaction head is never
      // consumed; this turn closes it via `turn.consumed.stale`.
      const { consumed: pending, stale } = boundaryConsumption(
        pendingBacklog(kernel, sessionId),
        "turn_end",
        consumptionSettings(kernel, sessionId),
        kernel.compactionHead(sessionId),
      );
      const evaluatedPrompts = yield* captured.provide(evaluatePromptPolicies(pending)).pipe(Effect.provide(runtime.services));
      if (evaluatedPrompts.refusal !== undefined) {
        yield* consumePolicyBlockedInbox(pending);
        return policyRefusalResult(evaluatedPrompts.refusal.reason);
      }
      // #1256 r3 H-3: a prompt.pre rewrite's output is what the turn delivers —
      // the delivery row's content is what the model later reads.
      const delivered = pending.map((item) => {
        const body = evaluatedPrompts.contents.get(item.id);
        return body === undefined ? item : { ...item, content: body };
      });
      const resultId = entropy();
      const turnId = entropy();
      const parentActionId = kernel.latestAction(sessionId)?.id ?? null;
      const deliveries = deliveryActions(
        delivered,
        { kind: "turn", turnId },
        "before_llm",
        parentActionId,
      );
      const envelope = turnIntentAction({
        id: turnId,
        parentId: deliveries.at(-1)?.id ?? parentActionId,
        sessionId,
        resultId,
        inboxIds: pending.map((item) => item.id),
        consumedStale: stale.map((item) => item.id),
        generation,
        resumeCount: 0,
        boundaryActionId: parentActionId,
        at: clock(),
      });
      yield* commitSession({
        expectedRevision: kernel.row(sessionId).revision,
        actions: [...deliveries, envelope],
        state: "running",
      });
      observeDrained(delivered, turnId, "before_llm", clock(), observations, entropy);
      if (pending.some((item) => item.kind === "interrupt")) {
        const action = kernel.actionById(turnId);
        if (action === undefined) return yield* new AgentFailure({ operation: "session.turn", cause: `missing_turn:${turnId}` });
        yield* seal({
          turnId,
          resultId,
          resumeCount: 0,
          boundaryActionId: parentActionId,
          toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash,
          systemHash: generation.systemHash,
          policyGeneration: generation.policyGeneration,
          action,
        }, { kind: "interrupted" });
        return { kind: "interrupted" as const };
      }
      return yield* runTurn({
        turnId,
        resultId,
        parentActionId: envelope.id,
        boundaryActionId: parentActionId,
        resumeCount: 0,
        generation,
        resume: false,
      });
    }));
  }

  function evaluatePromptPolicies(
    items: readonly Inbox.Row[],
  ): Effect.Effect<
    { readonly refusal: SessionPolicyRefusal | undefined; readonly contents: ReadonlyMap<string, string> },
    ExecutionError,
    RunnerServices
  > {
    return Effect.gen(function* () {
      const ledger = createExecutionLedger();
      let refusal: SessionPolicyRefusal | undefined;
      // #1256 r3 H-3: prompt.pre rewrites (the registry's `body` field) — what
      // the boundary delivers (and the model reads) is the rewritten body.
      const contents = new Map<string, string>();
      for (const item of items) {
        if (item.kind !== "prompt") continue;
        const recorded: PlainValue = { inboxId: item.id, status: "recorded" };
        const executor = yield* createExecutor({
          ledger,
          identity: { sessionId, role: kernel.row(sessionId).role, parentActionId: item.id },
        });
        const outcome = yield* executor.runExisting({
          kind: "prompt",
          op: "inbox",
          intent: { inboxId: item.id, body: item.content, origin: item.origin.value, createdAt: item.createdAt, ordinal: item.ordinal },
          effect: { status: "recorded" },
        }, (pre) =>
          Effect.sync(() => {
            const value = pre.value;
            if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.body === "string" && value.body !== item.content)
              contents.set(item.id, value.body);
            return recorded;
          }));
        if (refusal !== undefined) continue;
        if (outcome.terminal !== "executed") refusal = new SessionPolicyRefusal(outcome.reason);
        else if (canonicalDigest(outcome.value) !== canonicalDigest(recorded)) refusal = new SessionPolicyRefusal("invalid_output");
      }
      return { refusal, contents };
    });
  }

  /** Blocked items leave the pending fold through committed no-op deliveries. */
  function consumePolicyBlockedInbox(items: readonly Inbox.Row[]): Effect.Effect<void, ExecutionError> {
    return Effect.suspend(() => {
      const current = kernel.row(sessionId);
      return commitSession({
        expectedRevision: current.revision,
        actions: deliveryActions(
          items,
          { kind: "inbox" },
          "before_llm",
          kernel.latestAction(sessionId)?.id ?? null,
        ),
        state: current.state,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid);
    });
  }

  function createExecutionLedger(turnId?: string): SessionActionCommitPort {
    const executionFence = state.fence;
    return {
      actionById: kernel.actionById,
      requestById: kernel.requestById,
      resultFor: (id) => kernel.resultFor(sessionId, id),
      openOperationsPage: (id, cursor) => kernel.openOperationsPage(sessionId, id, cursor),
      operationChildrenPage: (id, cursor) => kernel.operationChildrenPage(sessionId, id, cursor),
      guardedOperationsPage: (id, cursor) => kernel.guardedOperationsPage(sessionId, id, cursor),
      validateRequest(request) {
        const row = kernel.row(sessionId);
        return row.fenceOwner === owner && row.fence === executionFence &&
          row.toolsGeneration === request.toolsGeneration &&
          row.systemHash === request.systemHash && row.policyGeneration === request.generation &&
          (runtime.requestDomainRevisions === undefined || canonicalDigest({ ...runtime.requestDomainRevisions(request) }) === canonicalDigest(request.domainRevisions));
      },
      transition(payload, inputId, at) {
        return Effect.gen(function* () {
          const current = kernel.row(sessionId);
          if (current.fence !== executionFence || (turnId !== undefined && kernel.turnTerminalFor(sessionId, turnId) !== undefined))
            return yield* new AgentFailure({ operation: "session.request.transition", cause: "stale" });
          return yield* commitSessionRequest(kernel, sessionId, { owner, fence: executionFence }, payload, inputId, at, runtime);
        });
      },
      commit(action) {
        return Effect.gen(function* () {
          const current = kernel.row(sessionId);
          const sealed = turnId !== undefined && kernel.turnTerminalFor(sessionId, turnId) !== undefined;
          if (current.fence !== executionFence || sealed || state.terminalFrozen) return yield* new CommitRefused({
            sessionId, reason: "fence", expectedRevision: current.revision,
            currentRevision: current.revision, fence: executionFence, currentFence: current.fence,
          });
          const committed = yield* commitSession({ expectedRevision: current.revision, actions: [action], state: current.state });
          const receipt = committed.receipts[0];
          if (receipt === undefined) return yield* new AgentFailure({ operation: "session.commit", cause: "missing_receipt" });
          return receipt;
        });
      },
    };
  }

  function restoreContextProjection(compactionId: string): Effect.Effect<ExecutionResult, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const current = kernel.row(sessionId);
      return yield* Effect.scoped(Effect.gen(function* () {
        const source = yield* requireCompactionIntent(kernel.actionById(compactionId));
        if (source.sessionId !== sessionId) return yield* new AgentFailure({ operation: "session.restore", cause: "foreign_compaction" });
        const record = yield* recordedCompaction(compactionId, kernel.resultFor(sessionId, compactionId));
        const history = hydrateSessionHistory(kernel, sessionId).history;
        const restored = restoredContextProjection(history, compactionId, record);
        const projectionHash = canonicalDigest({ foldVersion: 1, projection: PlainValueSchema.parse(history) });
        const captured = yield* runtime.generations.capture({ sessionId, generation: kernel.latestGenerationFor(sessionId).generation });
        const executor = yield* captured.provide(createExecutor({
          ledger: createExecutionLedger(),
          identity: { sessionId, role: current.role, parentActionId: compactionId },
        })).pipe(Effect.provide(runtime.services));
        return yield* captured.provide(executor.run(restoreContextRequest(compactionId, projectionHash), () => Effect.succeed(restored)));
      }));
    });
  }

  function resumeTurn(open: SessionHandleStore.OpenTurn): Effect.Effect<SessionRunnerResult, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      if (pendingBacklog(kernel, sessionId).some((item) => item.kind === "interrupt")) {
        const interrupted = { kind: "interrupted" as const };
        yield* seal(open, interrupted);
        return interrupted;
      }
      if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
        const exhausted = { kind: "error" as const, text: "session resume budget exhausted" };
        yield* seal(open, exhausted);
        return exhausted;
      }
      const generation = yield* generationForOpen(kernel, open);
      const resumeCount = open.resumeCount + 1;
      const resumeId = entropy();
      const resultId = open.resultId;
      const resume = turnResumeAction({ id: resumeId, parentId: open.boundaryActionId ?? open.action.id, sessionId, turnId: open.turnId, resultId, generation, resumeCount, boundaryActionId: open.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: kernel.row(sessionId).revision, actions: [resume], state: "running" });
      return yield* runTurn({ turnId: open.turnId, resultId, parentActionId: resumeId, boundaryActionId: open.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function resumeInterrupted(item: Inbox.Row): Effect.Effect<SessionRunnerResult | undefined, AdmissionError> {
    return Effect.gen(function* () {
      yield* awaitRetainedRunner();
      const terminal = kernel.latestTurnTerminal(sessionId);
      if (terminal?.effect.kind !== "interrupted") {
        yield* consumeNoopInbox([item]);
        return undefined;
      }
      const current = kernel.row(sessionId);
      const generation = kernel.latestGenerationFor(sessionId);
      const resultId = entropy();
      const turnId = entropy();
      const resumeCount = terminal.effect.resumeCount + 1;
      const delivery = deliveryActions(
        [item],
        { kind: "turn", turnId },
        "before_llm",
        terminal.action.id,
      );
      const resume = turnIntentAction({ id: turnId, parentId: delivery.at(-1)?.id ?? terminal.action.id, sessionId, resultId, inboxIds: [item.id], generation, resumeCount, boundaryActionId: terminal.effect.boundaryActionId, at: clock() });
      yield* commitSession({ expectedRevision: current.revision, actions: [...delivery, resume], state: "running" });
      return yield* runTurn({ turnId, resultId, parentActionId: resume.id, boundaryActionId: terminal.effect.boundaryActionId, resumeCount, generation, resume: true });
    });
  }

  function consumeNoopInbox(items: readonly Inbox.Row[]): Effect.Effect<void, AdmissionError> {
    return Effect.gen(function* () {
      const current = kernel.row(sessionId);
      const noops = deliveryActions(
        items,
        { kind: "inbox" },
        "before_llm",
        kernel.latestAction(sessionId)?.id ?? null,
      );
      yield* commitSession({ expectedRevision: current.revision, actions: noops, state: current.state });
    });
  }

  return { startTurn, evaluatePromptPolicies, consumePolicyBlockedInbox, commitSession, createExecutionLedger, resumeTurn, resumeInterrupted, consumeNoopInbox, restoreContextProjection };
}

/**
 * Out-of-turn request authority over a possibly-live activation (W5.2 F5):
 * adopting a fresh fence while an entity turn is running would steal that
 * activation's authority and kill its wave. This kernel view instead BORROWS
 * the running activation's owner+fence: `adoptFence` on a running session
 * records the live pair (and the borrowing caller) without touching the row,
 * `row()` reports the borrowing caller as `fenceOwner` so the pure request
 * decision (`ownsRequestRevision`) runs under the true live authority, and the
 * commit lands under the live owner+fence (same process: it lands between the
 * turn's awaits). Fence and revision are never masked — a rotated fence or a
 * moved revision still refuses — and only the caller that adopted through this
 * view gains the borrow; any other owner keeps being rejected. An idle session
 * falls back to a real adoption, the documented out-of-turn takeover.
 */
export function requestAuthorityKernel(base: SessionKernel, sessionId: string): SessionKernel {
  const holder: {
    borrowed: { readonly owner: string; readonly fence: number } | undefined;
    caller: string | undefined;
  } = { borrowed: undefined, caller: undefined };
  return {
    ...base,
    row: (id: string) => {
      const row = base.row(id);
      return holder.borrowed !== undefined && holder.caller !== undefined && id === sessionId
        ? { ...row, fenceOwner: holder.caller }
        : row;
    },
    adoptFence: (input) =>
      Effect.suspend(() => {
        const row = base.row(sessionId);
        if (input.sessionId === sessionId && row.state === "running" && row.fenceOwner !== null) {
          holder.borrowed = { owner: row.fenceOwner, fence: row.fence };
          holder.caller = input.owner;
          return Effect.succeed({ ok: true as const, fence: row.fence });
        }
        return base.adoptFence(input);
      }),
    commit: (input) =>
      base.commit(
        holder.borrowed === undefined
          ? input
          : { ...input, owner: holder.borrowed.owner, fence: holder.borrowed.fence },
      ),
  };
}
