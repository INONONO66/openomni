import { PolicyEngine, type PolicyRegistration } from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import * as Definitions from "./subagent-spawn-definitions.js";
import {
  createDefaultDenylist as createDefaultDenylistRegistration,
  createSubagentOperationDescriptor,
  defaultCancelHardTimeoutMs,
  emptyUsage,
} from "./subagent-spawn-decisions.js";
import { createSubagentSpawnRegistrations } from "./subagent-spawn-registrations.js";
import type {
  ChildRuntimeMiddlewareInput,
  PreSpawnContext,
  PreSpawnPolicyContext,
  PreSpawnResult,
  PreSpawnState,
  WaitTimeoutHandle,
} from "./subagent-spawn-types.js";

export namespace SubagentSpawnPolicyMiddleware {
  export const DefaultDenylist = Definitions.DefaultDenylist;
  export const SessionExistence = Definitions.SessionExistence;
  export const ActiveRun = Definitions.ActiveRun;
  export const CancelTimeout = Definitions.CancelTimeout;
  export const WaitTimeout = Definitions.WaitTimeout;

  export function createDefaultDenylist(): PolicyRegistration {
    return createDefaultDenylistRegistration();
  }

  export function buildChildRuntimeMiddleware(
    input: ChildRuntimeMiddlewareInput,
  ): PolicyRegistration[] {
    return childMiddleware(input.middleware, input.hasExplicitRuntimePolicy) ?? [];
  }

  export function childMiddleware(
    middleware: PolicyRegistration[] | undefined,
    hasExplicitRuntimePolicy: boolean,
  ): PolicyRegistration[] | undefined {
    const childMiddleware = middleware === undefined ? undefined : [...middleware];
    if (hasExplicitRuntimePolicy) return childMiddleware;
    return [createDefaultDenylist(), ...(childMiddleware ?? [])];
  }

  export function registrations(state: PreSpawnState): PolicyRegistration[] {
    return createSubagentSpawnRegistrations(state);
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

    const policyContext: PreSpawnPolicyContext = {
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
      resourceDescriptor: createSubagentOperationDescriptor(ctx.operation),
    };
    const verdict = await engine.dispatch("invoke.prepare", policyContext);

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
    if (PolicyDecision.isBlocking(result.verdict)) {
      throw new Error(PolicyDecision.reason(result.verdict, "subagent pre-spawn policy aborted"));
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
