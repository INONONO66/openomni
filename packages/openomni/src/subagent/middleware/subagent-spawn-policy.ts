import {
  MiddlewareEngine,
  type MiddlewareDecision,
  type MiddlewareRegistration,
} from "@openomni/agent";
import type { Hook, Middleware, TraceContext } from "@openomni/protocol";
import { Session, WorkerRun, type WorkerRunRecord } from "@openomni/session";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const defaultCancelHardTimeoutMs = 10_000;

type SessionRecord = NonNullable<ReturnType<typeof Session.get>>;

type PreSpawnOperation = "send" | "resume" | "cancel" | "wait";

interface PreSpawnState {
  readonly operation: PreSpawnOperation;
  readonly sessionId: string;
  readonly hardTimeoutMs?: number;
  readonly timeoutMs?: number;
  session?: SessionRecord;
  runs?: WorkerRunRecord[];
  latestRun?: WorkerRunRecord;
  cancelHardTimeoutMs?: number;
  waitTimeoutMs?: number;
}

function continueVerdict(policyId: string, reason: string): Hook.Verdict {
  return { action: "continue", policyId, reason };
}

function abortVerdict(policyId: string, reason: string): Hook.Verdict {
  return { action: "abort", policyId, reason };
}

function createSessionExistence(state: PreSpawnState): MiddlewareRegistration {
  return {
    ...SubagentSpawnPolicyMiddleware.SessionExistence,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation === "wait") {
        return continueVerdict("subagent.session-existence", "wait resolves worker run directly");
      }

      const session = Session.get(state.sessionId);
      if (!session) {
        return abortVerdict("subagent.session-existence", `Session not found: ${state.sessionId}`);
      }

      state.session = session;
      return continueVerdict("subagent.session-existence", "session exists");
    },
  };
}

function createActiveRunGuard(state: PreSpawnState): MiddlewareRegistration {
  return {
    ...SubagentSpawnPolicyMiddleware.ActiveRun,
    failPolicy: "fail-closed",
    async fn() {
      if (state.operation !== "resume") {
        return continueVerdict("subagent.active-run", "active-run check not required");
      }

      const runs = await WorkerRun.listBySession(state.sessionId);
      const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
      state.runs = runs;
      state.latestRun = latestRun;

      if (latestRun?.status === "running" || latestRun?.status === "starting") {
        return abortVerdict("subagent.active-run", "Session already has an active run");
      }

      return continueVerdict("subagent.active-run", "session has no active latest run");
    },
  };
}

function createCancelTimeout(state: PreSpawnState): MiddlewareRegistration {
  return {
    ...SubagentSpawnPolicyMiddleware.CancelTimeout,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation !== "cancel") {
        return continueVerdict("subagent.cancel-timeout", "cancel timeout not required");
      }

      state.cancelHardTimeoutMs = state.hardTimeoutMs ?? defaultCancelHardTimeoutMs;
      return continueVerdict("subagent.cancel-timeout", "cancel timeout resolved");
    },
  };
}

function createWaitTimeout(state: PreSpawnState): MiddlewareRegistration {
  return {
    ...SubagentSpawnPolicyMiddleware.WaitTimeout,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation !== "wait") {
        return continueVerdict("subagent.wait-timeout", "wait timeout not required");
      }

      state.waitTimeoutMs = state.timeoutMs;
      return continueVerdict(
        "subagent.wait-timeout",
        state.timeoutMs === undefined ? "wait timeout disabled" : "wait timeout configured",
      );
    },
  };
}

export namespace SubagentSpawnPolicyMiddleware {
  export const DefaultDenylist = {
    name: "subagent:default-denylist",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const SessionExistence = {
    name: "subagent:session-existence",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const ActiveRun = {
    name: "subagent:active-run",
    timing: "pre_tool_use",
    priority: 10,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const CancelTimeout = {
    name: "subagent:cancel-timeout",
    timing: "pre_tool_use",
    priority: 20,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const WaitTimeout = {
    name: "subagent:wait-timeout",
    timing: "pre_tool_use",
    priority: 30,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export interface PreSpawnContext {
    readonly operation: PreSpawnOperation;
    readonly sessionId: string;
    readonly hardTimeoutMs?: number;
    readonly timeoutMs?: number;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  }

  export interface PreSpawnResult {
    readonly verdict: Hook.Verdict;
    readonly session?: SessionRecord;
    readonly runs?: WorkerRunRecord[];
    readonly latestRun?: WorkerRunRecord;
    readonly cancelHardTimeoutMs: number;
    readonly waitTimeoutMs?: number;
  }

  export interface WaitTimeoutHandle {
    readonly cancel: () => void;
  }

  export function createDefaultDenylist(): MiddlewareRegistration {
    return {
      ...DefaultDenylist,
      failPolicy: "fail-closed",
      fn: (ctx) => {
        if (ctx.toolName !== "subagent") {
          return continueVerdict("subagent.default-denylist", "tool is not subagent");
        }

        return abortVerdict("subagent.default-denylist", "denylist");
      },
    };
  }

  export function childMiddleware(
    middleware: MiddlewareRegistration[] | undefined,
    hasExplicitPermissions: boolean,
  ): MiddlewareRegistration[] | undefined {
    if (hasExplicitPermissions) return middleware;
    return [createDefaultDenylist(), ...(middleware ?? [])];
  }

  export function registrations(state: PreSpawnState): MiddlewareRegistration[] {
    return [
      createSessionExistence(state),
      createActiveRunGuard(state),
      createCancelTimeout(state),
      createWaitTimeout(state),
    ];
  }

  export async function evaluatePreSpawn(ctx: PreSpawnContext): Promise<PreSpawnResult> {
    const state: PreSpawnState = {
      operation: ctx.operation,
      sessionId: ctx.sessionId,
      hardTimeoutMs: ctx.hardTimeoutMs,
      timeoutMs: ctx.timeoutMs,
    };
    const engine = MiddlewareEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
      eventLog: false,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const verdict = await engine.dispatch("pre_tool_use", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolName: "subagent",
      toolInput: {
        operation: ctx.operation,
        sessionId: ctx.sessionId,
        ...(ctx.hardTimeoutMs !== undefined && { hardTimeoutMs: ctx.hardTimeoutMs }),
        ...(ctx.timeoutMs !== undefined && { timeoutMs: ctx.timeoutMs }),
      },
      traceContext: ctx.traceContext,
    });

    return {
      verdict,
      ...(state.session !== undefined && { session: state.session }),
      ...(state.runs !== undefined && { runs: state.runs }),
      ...(state.latestRun !== undefined && { latestRun: state.latestRun }),
      cancelHardTimeoutMs: state.cancelHardTimeoutMs ?? defaultCancelHardTimeoutMs,
      ...(state.waitTimeoutMs !== undefined && { waitTimeoutMs: state.waitTimeoutMs }),
    };
  }

  export async function runPreSpawn(ctx: PreSpawnContext): Promise<PreSpawnResult> {
    const result = await evaluatePreSpawn(ctx);
    if (result.verdict.action !== "continue") {
      throw new Error(result.verdict.reason ?? "subagent pre-spawn policy aborted");
    }
    return result;
  }

  export function enforceWaitTimeout(
    timeoutMs: number | undefined,
    onTimeout: () => void,
  ): WaitTimeoutHandle | undefined {
    if (!timeoutMs) return undefined;
    const timeoutHandle = setTimeout(onTimeout, timeoutMs);
    return { cancel: () => clearTimeout(timeoutHandle) };
  }
}
