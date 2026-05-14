import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import { Policy, type TraceContext } from "@openomni/protocol";
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

function continueVerdict(policyId: string, reason: string): Policy.Verdict {
  return { action: "continue", policyId, reason };
}

function evaluateBooleanPolicy(input: {
  readonly action: string;
  readonly resource: string;
  readonly field: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly metadata?: Record<string, unknown>;
}): Policy.Verdict {
  return Policy.evaluate(
    {
      action: input.action,
      inputRules: [
        {
          toolPattern: input.resource,
          field: input.field,
          pattern: "^true$",
          action: "allow",
          reason: input.allowReason,
          priority: 2,
        },
        {
          toolPattern: input.resource,
          field: input.field,
          pattern: "^false$",
          action: "deny",
          reason: input.denyReason,
          priority: 1,
        },
      ],
    },
    {
      action: input.action,
      resource: input.resource,
      input: { [input.field]: String(input.allowed) },
      metadata: input.metadata,
    },
  );
}

function createSessionExistence(state: PreSpawnState): PolicyRegistration {
  return {
    ...SubagentSpawnPolicyMiddleware.SessionExistence,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation === "wait") {
        return evaluateBooleanPolicy({
          action: "subagent.wait",
          resource: state.sessionId,
          field: "sessionCheckRequired",
          allowed: true,
          allowReason: "wait resolves worker run directly",
          denyReason: "wait session check blocked",
        });
      }

      const session = Session.get(state.sessionId);
      if (!session) {
        return evaluateBooleanPolicy({
          action: `subagent.${state.operation}`,
          resource: state.sessionId,
          field: "sessionExists",
          allowed: false,
          allowReason: "session exists",
          denyReason: `Session not found: ${state.sessionId}`,
        });
      }

      state.session = session;
      return evaluateBooleanPolicy({
        action: `subagent.${state.operation}`,
        resource: state.sessionId,
        field: "sessionExists",
        allowed: true,
        allowReason: "session exists",
        denyReason: `Session not found: ${state.sessionId}`,
      });
    },
  };
}

function createActiveRunGuard(state: PreSpawnState): PolicyRegistration {
  return {
    ...SubagentSpawnPolicyMiddleware.ActiveRun,
    failPolicy: "fail-closed",
    async fn() {
      if (state.operation !== "resume") {
        return evaluateBooleanPolicy({
          action: `subagent.${state.operation}`,
          resource: state.sessionId,
          field: "activeRunAllowed",
          allowed: true,
          allowReason: "active-run check not required",
          denyReason: "Session already has an active run",
        });
      }

      const runs = await WorkerRun.listBySession(state.sessionId);
      const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
      state.runs = runs;
      state.latestRun = latestRun;

      if (latestRun?.status === "running" || latestRun?.status === "starting") {
        return evaluateBooleanPolicy({
          action: "subagent.resume",
          resource: state.sessionId,
          field: "activeRunAllowed",
          allowed: false,
          allowReason: "session has no active latest run",
          denyReason: "Session already has an active run",
        });
      }

      return evaluateBooleanPolicy({
        action: "subagent.resume",
        resource: state.sessionId,
        field: "activeRunAllowed",
        allowed: true,
        allowReason: "session has no active latest run",
        denyReason: "Session already has an active run",
      });
    },
  };
}

function createCancelTimeout(state: PreSpawnState): PolicyRegistration {
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

function createWaitTimeout(state: PreSpawnState): PolicyRegistration {
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
    timing: "invoke.prepare",
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const SessionExistence = {
    name: "subagent:session-existence",
    timing: "invoke.prepare",
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const ActiveRun = {
    name: "subagent:active-run",
    timing: "invoke.prepare",
    priority: 10,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const CancelTimeout = {
    name: "subagent:cancel-timeout",
    timing: "invoke.prepare",
    priority: 20,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const WaitTimeout = {
    name: "subagent:wait-timeout",
    timing: "invoke.prepare",
    priority: 30,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export interface PreSpawnContext {
    readonly operation: PreSpawnOperation;
    readonly sessionId: string;
    readonly hardTimeoutMs?: number;
    readonly timeoutMs?: number;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: PolicyDecision) => void | Promise<void>;
  }

  export interface PreSpawnResult {
    readonly verdict: Policy.Verdict;
    readonly session?: SessionRecord;
    readonly runs?: WorkerRunRecord[];
    readonly latestRun?: WorkerRunRecord;
    readonly cancelHardTimeoutMs: number;
    readonly waitTimeoutMs?: number;
  }

  export interface WaitTimeoutHandle {
    readonly cancel: () => void;
  }

  export function createDefaultDenylist(): PolicyRegistration {
    return {
      ...DefaultDenylist,
      failPolicy: "fail-closed",
      fn: (ctx) => {
        const toolName = ctx.toolName ?? "";
        if (ctx.toolName !== "subagent") {
          return Policy.evaluate(
            { action: "tool.call", denylist: ["subagent"] },
            { action: "tool.call", resource: toolName },
          );
        }

        return Policy.evaluate(
          { action: "tool.call", denylist: ["subagent"] },
          { action: "tool.call", resource: toolName },
        );
      },
    };
  }

  export function childMiddleware(
    middleware: PolicyRegistration[] | undefined,
    hasExplicitPermissions: boolean,
  ): PolicyRegistration[] | undefined {
    if (hasExplicitPermissions) return middleware;
    return [createDefaultDenylist(), ...(middleware ?? [])];
  }

  export function registrations(state: PreSpawnState): PolicyRegistration[] {
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
    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
      audit: false,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const verdict = await engine.dispatch("invoke.prepare", {
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
