import { SessionHandleStore } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import {
  canonicalDigest,
  type SessionGeneration,
  type Inbox,
  type LedgerAction,
  type LedgerSession,
  type PlainValue,
} from "@openomni/protocol";
import { createExecutor } from "./executor";
import {
  SessionPolicyRefusal,
  SessionCommitError,
  type SessionRuntime,
  type SessionRunnerResult,
  type SessionActionCommitPort,
} from "./session-contract";
import {
  latestTerminal,
  requireCommit,
  turnIntentAction,
  turnResumeAction,
  deliveryActions,
  policyRefusalResult,
  generationForOpen,
} from "./session-record";
import type { SessionControllerState } from "./session-controller-state";
import { observeDrained } from "./session-message-observation";

export function createSessionAdmission(
  sessionId: string,
  runtime: SessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
  ports: {
    readonly awaitRetainedRunner: () => Promise<void>;
    readonly acquire: (expectedFence: number) => number;
    readonly runTurn: (input: {
      readonly turnId: string;
      readonly resultId: string;
      readonly parentActionId: string;
      readonly boundaryActionId: string | null;
      readonly resumeCount: number;
      readonly generation: SessionGeneration.Snapshot;
      readonly resume: boolean;
    }) => Promise<SessionRunnerResult>;
    readonly seal: (
      open: SessionHandleStore.OpenTurn,
      result: SessionRunnerResult,
      releaseLease: boolean,
    ) => Promise<void>;
  },
) {
  const { awaitRetainedRunner, acquire, runTurn, seal } = ports;
  async function startTurn(): Promise<SessionRunnerResult | undefined> {
    await awaitRetainedRunner();
    const current = SessionHandleStore.row(sessionId);
    state.fence = acquire(current.leaseFence);
    const actions = SessionHandleStore.tree(sessionId);
    const generation = SessionHandleStore.latestGeneration(actions);
    const pending = SessionHandleStore.pendingInbox(sessionId);
    const promptRefusal = await evaluatePromptPolicies(
      pending,
      pinPolicy(generation.policyGeneration),
    );
    if (promptRefusal !== undefined) {
      await consumePolicyBlockedInbox(pending, true);
      return policyRefusalResult(promptRefusal.reason);
    }
    const resultId = entropy();
    const turnId = entropy();
    const currentActions = SessionHandleStore.tree(sessionId);
    const parentActionId = currentActions.at(-1)?.id ?? null;
    const deliveries = deliveryActions(pending, turnId, "before_llm", parentActionId);
    const envelope = turnIntentAction({
      id: turnId,
      parentId: deliveries.at(-1)?.id ?? parentActionId,
      sessionId,
      resultId,
      inboxIds: pending.map((item) => item.id),
      generation,
      resumeCount: 0,
      boundaryActionId: parentActionId,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: SessionHandleStore.row(sessionId).revision,
      actions: [...deliveries, envelope],
      consumeInboxIds: pending.map((item) => item.id),
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    observeDrained(pending, turnId, "before_llm", clock(), runtime.observations);
    if (pending.some((item) => item.kind === "interrupt")) {
      const action = SessionHandleStore.tree(sessionId).find((item) => item.id === turnId);
      if (action === undefined) throw new Error(`committed turn is missing: ${turnId}`);
      const interrupted = { kind: "interrupted" as const };
      await seal(
        {
          turnId,
          resultId,
          resumeCount: 0,
          boundaryActionId: parentActionId,
          toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash,
          systemHash: generation.systemHash,
          policyGeneration: generation.policyGeneration,
          action,
        },
        interrupted,
        true,
      );
      return interrupted;
    }
    return runTurn({
      turnId,
      resultId,
      parentActionId: envelope.id,
      boundaryActionId: parentActionId,
      resumeCount: 0,
      generation,
      resume: false,
    });
  }

  async function evaluatePromptPolicies(
    items: readonly Inbox.Row[],
    policy: CompiledPolicySnapshot,
  ): Promise<SessionPolicyRefusal | undefined> {
    const ledger = createExecutionLedger();
    let refusal: SessionPolicyRefusal | undefined;
    for (const item of items) {
      if (item.kind !== "prompt") continue;
      const recorded: PlainValue = { inboxId: item.id, status: "recorded" };
      const outcome = await createExecutor({
        policy,
        ledger,
        observations: runtime.observations,
        identity: {
          sessionId,
          role: SessionHandleStore.row(sessionId).role,
          parentActionId: item.id,
        },
        clock,
        entropy,
      }).runExisting(
        {
          kind: "prompt",
          op: "inbox",
          intent: {
            inboxId: item.id,
            content: item.content,
            origin: item.origin.value,
            createdAt: item.createdAt,
            ordinal: item.ordinal,
          },
          effect: { status: "recorded" },
        },
        async () => recorded,
      );
      if (refusal !== undefined) continue;
      if (outcome.terminal !== "executed") {
        refusal = new SessionPolicyRefusal(outcome.reason);
      } else if (canonicalDigest(outcome.value) !== canonicalDigest(recorded)) {
        refusal = new SessionPolicyRefusal("invalid_output");
      }
    }
    return refusal;
  }

  async function consumePolicyBlockedInbox(
    items: readonly Inbox.Row[],
    releaseLease: boolean,
  ): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    commitSession({
      expectedRevision: current.revision,
      actions: [],
      consumeInboxIds: items.map((item) => item.id),
      state: current.state,
      releaseLease,
    });
  }

  function commitSession(input: {
    readonly expectedRevision: number;
    readonly actions: readonly LedgerAction.Append[];
    readonly consumeInboxIds: readonly string[];
    readonly state: LedgerSession.State;
    readonly releaseLease: boolean;
    readonly generation?: LedgerSession.GenerationPointers;
  }): Extract<LedgerSession.CommitResult, { readonly ok: true }> {
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: input.expectedRevision,
      actions: [...input.actions],
      consumeInboxIds: [...input.consumeInboxIds],
      state: input.state,
      ...(input.generation === undefined ? {} : { generation: input.generation }),
      releaseLease: input.releaseLease,
    });
    if (!committed.ok) throw new SessionCommitError(committed);
    return committed;
  }

  function createExecutionLedger(turnId?: string): SessionActionCommitPort {
    const executionFence = state.fence;
    return {
      async commit(action) {
        const current = SessionHandleStore.row(sessionId);
        const sealed =
          turnId !== undefined &&
          SessionHandleStore.tree(sessionId).some(
            (node) => SessionHandleStore.turnTerminal(node)?.turnId === turnId,
          );
        if (current.leaseFence !== executionFence || sealed) {
          throw new SessionCommitError({
            ok: false,
            reason: "stale",
            currentFence: current.leaseFence,
            currentRevision: current.revision,
          });
        }
        const receipt = commitSession({
          expectedRevision: current.revision,
          actions: [action],
          consumeInboxIds: [],
          state: current.state,
          releaseLease: false,
        }).receipts[0];
        if (receipt === undefined) throw new Error("single-action commit returned no receipt");
        return receipt;
      },
    };
  }

  async function resumeTurn(open: SessionHandleStore.OpenTurn): Promise<SessionRunnerResult> {
    await awaitRetainedRunner();
    state.fence = acquire(SessionHandleStore.row(sessionId).leaseFence);
    if (SessionHandleStore.pendingInbox(sessionId).some((item) => item.kind === "interrupt")) {
      const interrupted = { kind: "interrupted" as const };
      await seal(open, interrupted, true);
      return interrupted;
    }
    if (open.resumeCount >= SessionHandleStore.RESUME_BUDGET) {
      const exhausted = { kind: "error" as const, text: "session resume budget exhausted" };
      await seal(open, exhausted, true);
      return exhausted;
    }
    const generation = generationForOpen(open);
    const resumeCount = open.resumeCount + 1;
    const resumeId = entropy();
    const resultId = open.resultId;
    const resume = turnResumeAction({
      id: resumeId,
      parentId: open.boundaryActionId ?? open.action.id,
      sessionId,
      turnId: open.turnId,
      resultId,
      generation,
      resumeCount,
      boundaryActionId: open.boundaryActionId,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: SessionHandleStore.row(sessionId).revision,
      actions: [resume],
      consumeInboxIds: [],
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    return runTurn({
      turnId: open.turnId,
      resultId,
      parentActionId: resumeId,
      boundaryActionId: open.boundaryActionId,
      resumeCount,
      generation,
      resume: true,
    });
  }

  async function resumeInterrupted(item: Inbox.Row): Promise<SessionRunnerResult | undefined> {
    await awaitRetainedRunner();
    const terminal = latestTerminal(SessionHandleStore.tree(sessionId));
    if (terminal === undefined) {
      await consumeNoopInbox([item]);
      return undefined;
    }
    const current = SessionHandleStore.row(sessionId);
    state.fence = acquire(current.leaseFence);
    const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(sessionId));
    const resultId = entropy();
    const turnId = entropy();
    const resumeCount = terminal.effect.resumeCount + 1;
    const delivery = deliveryActions([item], turnId, "before_llm", terminal.action.id);
    const resume = turnIntentAction({
      id: turnId,
      parentId: delivery.at(-1)?.id ?? terminal.action.id,
      sessionId,
      resultId,
      inboxIds: [item.id],
      generation,
      resumeCount,
      boundaryActionId: terminal.effect.boundaryActionId,
      at: clock(),
    });
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [...delivery, resume],
      consumeInboxIds: [item.id],
      state: "running",
      releaseLease: false,
    });
    requireCommit(committed);
    return runTurn({
      turnId,
      resultId,
      parentActionId: resume.id,
      boundaryActionId: terminal.effect.boundaryActionId,
      resumeCount,
      generation,
      resume: true,
    });
  }

  async function consumeNoopInbox(items: readonly Inbox.Row[]): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    state.fence = acquire(current.leaseFence);
    const actions = SessionHandleStore.tree(sessionId);
    const noops = deliveryActions(items, "noop", "before_llm", actions.at(-1)?.id ?? null);
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: noops,
      consumeInboxIds: items.map((item) => item.id),
      state: current.state,
      releaseLease: true,
    });
    requireCommit(committed);
  }
  return {
    startTurn,
    evaluatePromptPolicies,
    consumePolicyBlockedInbox,
    commitSession,
    createExecutionLedger,
    resumeTurn,
    resumeInterrupted,
    consumeNoopInbox,
  };
}
