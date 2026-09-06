import { SessionHandleStore } from "@openomni/ledger";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import {
  canonicalDigest,
  type SessionGeneration,
  type SessionTurn,
  type Inbox,
  type LedgerSession,
  type PlainValue,
} from "@openomni/protocol";
import { createExecutor } from "./executor";
import { sessionHistory } from "./session-history";
import { sessionStopEvidence } from "./session-stop-evidence";
import type {
  SessionPolicyRefusal,
  SessionRuntime,
  SessionRunner,
  SessionRunnerResult,
  SessionActionCommitPort,
  SessionBoundaryResult,
} from "./session-contract";
import {
  sessionMessages,
  requireCommit,
  turnCheckpointAction,
  deliveryActions,
  turnTerminalAction,
  policyRefusalResult,
  sessionRunnerResultValue,
  sessionRunnerResultFromValue,
} from "./session-record";
import type { SessionControllerState } from "./session-controller-state";

export function createSessionTurn(
  sessionId: string,
  runner: SessionRunner,
  runtime: SessionRuntime,
  state: SessionControllerState,
  owner: string,
  clock: () => number,
  entropy: () => string,
  scheduleHeartbeat: (callback: () => void, intervalMs: number) => () => void,
  pinPolicy: (generation: number) => CompiledPolicySnapshot,
  ports: {
    readonly createExecutionLedger: (turnId?: string) => SessionActionCommitPort;
    readonly evaluatePromptPolicies: (
      items: readonly Inbox.Row[],
      policy: CompiledPolicySnapshot,
    ) => Promise<SessionPolicyRefusal | undefined>;
    readonly consumePolicyBlockedInbox: (
      items: readonly Inbox.Row[],
      releaseLease: boolean,
    ) => Promise<void>;
    readonly releaseHeldLease: () => Promise<void>;
    readonly hibernate: (current: LedgerSession.Row) => Promise<void>;
  },
) {
  const {
    createExecutionLedger,
    evaluatePromptPolicies,
    consumePolicyBlockedInbox,
    releaseHeldLease,
    hibernate,
  } = ports;
  async function runTurn(input: {
    readonly turnId: string;
    readonly resultId: string;
    readonly parentActionId: string;
    readonly boundaryActionId: string | null;
    readonly resumeCount: number;
    readonly generation: SessionGeneration.Snapshot;
    readonly resume: boolean;
  }): Promise<SessionRunnerResult> {
    const row = SessionHandleStore.row(sessionId);
    const turnController = new AbortController();
    state.controller = turnController;
    state.stopHeartbeat = scheduleHeartbeat(() => {
      const now = clock();
      const renewed = SessionHandleStore.renewLease({
        sessionId,
        owner,
        fence: state.fence,
        now,
        expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
      });
      if (!renewed) {
        // The lease was stolen or lapsed: this executor no longer owns the
        // session. Stop renewing at once and abort the runner.
        state.stopHeartbeat?.();
        state.stopHeartbeat = undefined;
        turnController.abort();
      }
    }, SessionHandleStore.HEARTBEAT_INTERVAL_MS);
    let parentActionId = input.parentActionId;
    let boundaryActionId = input.boundaryActionId;
    let result: SessionRunnerResult;
    let interruptedRunner: Promise<SessionRunnerResult> | undefined;
    const effects = new Set<Promise<void>>();
    const waves = new Set<Promise<void>>();
    const retainEffect = (effect: Promise<void>) => {
      effects.add(effect);
      void effect.then(() => effects.delete(effect));
    };
    const trackWave = (wave: Promise<void>) => {
      waves.add(wave);
      void wave.then(
        () => waves.delete(wave),
        () => waves.delete(wave),
      );
    };
    const policy = pinPolicy(input.generation.policyGeneration);
    const ledger = createExecutionLedger(input.turnId);
    const execution = createExecutor({
      waitRetry: runtime.waitRetry,
      signal: turnController.signal,
      retainEffect,
      policy,
      ledger,
      observations: runtime.observations,
      identity: { sessionId, role: row.role, parentActionId: input.turnId },
      clock,
      entropy,
    });
    const boundary = async (kind: SessionTurn.Boundary): Promise<SessionBoundaryResult> => {
      if (turnController.signal.aborted) return { messages: [], interrupted: true };
      const drained = await drainBoundary(
        input.turnId,
        input.resultId,
        kind,
        input.resumeCount,
        parentActionId,
        policy,
      );
      parentActionId = drained.parentActionId;
      boundaryActionId = drained.boundaryActionId;
      if (drained.interrupted) turnController.abort();
      return { messages: drained.messages, interrupted: drained.interrupted };
    };
    try {
      const aborted = new Promise<SessionRunnerResult>((resolve) => {
        turnController.signal.addEventListener(
          "abort",
          () => {
            void Promise.allSettled([...waves]).then(() =>
              resolve({ kind: "interrupted", text: "" }),
            );
          },
          { once: true },
        );
      });
      let running: Promise<SessionRunnerResult> | undefined;
      let runnerResult: SessionRunnerResult | undefined;
      let evaluatedResult: PlainValue | undefined;
      const outcome = await execution.runExisting(
        {
          kind: "turn",
          op: "session",
          intent: {
            turnId: input.turnId,
            resultId: input.resultId,
            resumeCount: input.resumeCount,
            resume: input.resume,
            toolsGeneration: input.generation.generation,
            toolsHash: input.generation.toolsHash,
            systemHash: input.generation.systemHash,
            policyGeneration: input.generation.policyGeneration,
          },
          effect: { terminal: "sealed" },
        },
        async () => {
          if (turnController.signal.aborted) {
            runnerResult = { kind: "interrupted", text: "" };
          } else {
            running = (async () => {
              try {
                return await runner({
                  sessionId,
                  role: row.role,
                  turnId: input.turnId,
                  actionId: input.parentActionId,
                  ledger,
                  retainEffect,
                  trackWave,
                  bindApprovals: (approvals) => {
                    state.activeApprovals = approvals;
                  },
                  policy,
                  stopEvidence: sessionStopEvidence(
                    sessionId,
                    input.turnId,
                    () => state.activeApprovals,
                    runtime.openIntent,
                  ),
                  resultId: input.resultId,
                  parentActionId,
                  boundaryActionId,
                  messages: sessionMessages(SessionHandleStore.tree(sessionId)),
                  history: sessionHistory(sessionId, SessionHandleStore.tree(sessionId)),
                  tools: input.generation.tools,
                  toolsGeneration: input.generation.generation,
                  toolsHash: input.generation.toolsHash,
                  system: input.generation.systemValue,
                  systemHash: input.generation.systemHash,
                  policyGeneration: input.generation.policyGeneration,
                  resumeCount: input.resumeCount,
                  signal: turnController.signal,
                  boundary,
                });
              } finally {
                while (effects.size > 0) await Promise.allSettled([...effects]);
              }
            })();
            try {
              runnerResult = await Promise.race([running, aborted]);
            } catch (error) {
              runnerResult = {
                kind: "error",
                text: error instanceof Error ? error.message : String(error),
                ...(error instanceof Error ? { cause: error } : {}),
              };
            }
          }
          evaluatedResult = sessionRunnerResultValue(runnerResult);
          return evaluatedResult;
        },
      );
      if (outcome.terminal !== "executed") {
        result = policyRefusalResult(outcome.reason);
      } else if (runnerResult === undefined || evaluatedResult === undefined) {
        result = policyRefusalResult("invalid_output");
      } else if (canonicalDigest(outcome.value) === canonicalDigest(evaluatedResult)) {
        result = runnerResult;
      } else {
        result =
          sessionRunnerResultFromValue(outcome.value) ?? policyRefusalResult("invalid_output");
      }
      if (turnController.signal.aborted && running !== undefined) {
        interruptedRunner = running;
        // Mark the live runner BEFORE the interrupted terminal is sealed: any
        // configure re-entered from a synchronous observation of that seal
        // must already see the lease as held by this executor.
        state.liveInterruptRunner = running;
        if (result.kind !== "interrupted") result = { kind: "interrupted", text: "" };
      }
    } catch (error) {
      result = turnController.signal.aborted
        ? { kind: "interrupted", text: "" }
        : {
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error ? { cause: error } : {}),
          };
    } finally {
      // When the runner ignored the abort and is still alive, keep the heartbeat
      // renewing the durable lease so that no other runtime can acquire it and
      // start a resumed runner; the lease and heartbeat are released only after
      // the runner settles below. Otherwise the runner has settled, so stop now.
      if (interruptedRunner === undefined) {
        state.stopHeartbeat?.();
        state.stopHeartbeat = undefined;
      }
      if (state.controller === turnController) state.controller = undefined;
    }
    const latestAction = SessionHandleStore.tree(sessionId).at(-1);
    if (latestAction === undefined) throw new Error(`session tree is empty: ${sessionId}`);
    await seal(
      {
        turnId: input.turnId,
        resultId: input.resultId,
        resumeCount: input.resumeCount,
        boundaryActionId,
        toolsGeneration: input.generation.generation,
        toolsHash: input.generation.toolsHash,
        systemHash: input.generation.systemHash,
        policyGeneration: input.generation.policyGeneration,
        action: latestAction,
      },
      result,
      interruptedRunner === undefined,
    );
    if (interruptedRunner !== undefined) {
      // The abort-ignoring runner is still alive and still holds the durable
      // lease (renewed by the heartbeat above). The interrupted terminal is
      // sealed, so the turn - and the caller's interrupt() - completes now;
      // ownership maintenance detaches into `retainedRunner`: once the runner
      // settles, stop the heartbeat and release the lease. Every turn start
      // waits on it, so a resume can only run once this executor is genuinely
      // gone - session-wide single flight without an unbounded caller wait.
      state.retainedRunner = interruptedRunner
        .then(
          () => undefined,
          () => undefined,
        )
        .then(async () => {
          state.liveInterruptRunner = undefined;
          state.stopHeartbeat?.();
          state.stopHeartbeat = undefined;
          try {
            await releaseHeldLease();
          } catch (error) {
            // Storage refused/failed the release: never wedge the controller on
            // a detached promise. Finalize in-memory state here and surface the
            // failure to the next caller that starts a turn.
            state.retainedFailure = error instanceof Error ? error : new Error(String(error));
          } finally {
            state.retainedRunner = undefined;
          }
          if (state.active === undefined) await hibernate(SessionHandleStore.row(sessionId));
        });
    }
    return result;
  }

  async function drainBoundary(
    turnId: string,
    resultId: string,
    boundary: SessionTurn.Boundary,
    resumeCount: number,
    parentActionId: string,
    policy: CompiledPolicySnapshot,
  ): Promise<{
    readonly messages: (SessionTurn.Message & { readonly id?: string })[];
    readonly interrupted: boolean;
    readonly parentActionId: string;
    readonly boundaryActionId: string;
  }> {
    const pending = SessionHandleStore.pendingInbox(sessionId);
    const promptRefusal = await evaluatePromptPolicies(pending, policy);
    if (promptRefusal !== undefined) {
      await consumePolicyBlockedInbox(pending, false);
      throw promptRefusal;
    }
    const checkpointId = entropy();
    const deliveries = deliveryActions(pending, turnId, boundary, checkpointId);
    const checkpoint = turnCheckpointAction({
      id: checkpointId,
      parentId: parentActionId,
      sessionId,
      turnId,
      resultId,
      resumeCount,
      boundaryActionId: checkpointId,
      boundary,
      at: clock(),
    });
    const current = SessionHandleStore.row(sessionId);
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [checkpoint, ...deliveries],
      consumeInboxIds: pending.map((item) => item.id),
      state: current.state === "interrupted" ? "interrupted" : "running",
      releaseLease: false,
    });
    requireCommit(committed);
    const interrupted = pending.some((item) => item.kind === "interrupt");
    const messages = pending
      .filter((item) => item.kind === "prompt")
      .map((item) => ({ id: item.id, role: "user" as const, text: item.content }));
    return {
      messages,
      interrupted,
      parentActionId: deliveries.at(-1)?.id ?? checkpointId,
      boundaryActionId: checkpointId,
    };
  }

  async function seal(
    open: SessionHandleStore.OpenTurn,
    result: SessionRunnerResult,
    releaseLease: boolean,
  ): Promise<void> {
    const current = SessionHandleStore.row(sessionId);
    const actions = SessionHandleStore.tree(sessionId);
    const interrupts =
      result.kind === "interrupted"
        ? SessionHandleStore.pendingInbox(sessionId).filter((item) => item.kind === "interrupt")
        : [];
    const deliveries = deliveryActions(
      interrupts,
      open.turnId,
      "before_llm",
      actions.at(-1)?.id ?? open.action.id,
    );
    const terminal = turnTerminalAction({
      id: open.resultId,
      parentId: deliveries.at(-1)?.id ?? actions.at(-1)?.id ?? open.action.id,
      sessionId,
      turnId: open.turnId,
      result,
      resumeCount: open.resumeCount,
      boundaryActionId: open.boundaryActionId,
      at: clock(),
    });
    const nextState = result.kind === "interrupted" ? "interrupted" : "idle";
    const committed = SessionHandleStore.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: clock(),
      expectedRevision: current.revision,
      actions: [...deliveries, terminal],
      consumeInboxIds: interrupts.map((item) => item.id),
      state: nextState,
      releaseLease,
    });
    requireCommit(committed);
  }
  return { runTurn, drainBoundary, seal };
}
