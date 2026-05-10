import type { ExecutionHooks, StepGuardContext, StepGuardVerdict, AgentStep } from "../types";
import type { MiddlewareContext, MiddlewareRegistration } from "./types";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

function toHookContext(ctx: MiddlewareContext) {
  return {
    toolName: ctx.toolName,
    toolCallId: ctx.toolCallId,
    input: ctx.toolInput,
    output: ctx.toolOutput,
    steps: ctx.steps,
    turnCount: ctx.turnCount,
    elapsedMs: ctx.elapsedMs,
  };
}

function toStepGuardContext(ctx: MiddlewareContext): StepGuardContext {
  return {
    steps: ctx.steps,
    usage: ctx.usage,
    turnCount: ctx.turnCount,
    isCompletion: ctx.isCompletion,
    continuationCount: ctx.continuationCount,
    elapsedMs: ctx.elapsedMs,
  };
}

export function fromExecutionHooks(hooks: ExecutionHooks): MiddlewareRegistration[] {
  const registrations: MiddlewareRegistration[] = [];

  if (hooks.preToolUse) {
    const fn = hooks.preToolUse;
    registrations.push({
      name: "compat:preToolUse",
      timing: "pre_tool_use",
      priority: 250,
      failPolicy: "fail-open",
      fn: async (ctx) => fn(toHookContext(ctx)),
    });
  }

  if (hooks.postToolUse) {
    const fn = hooks.postToolUse;
    registrations.push({
      name: "compat:postToolUse",
      timing: "post_tool_use",
      priority: 250,
      fn: async (ctx) => {
        try {
          return await fn(toHookContext(ctx));
        } catch (error) {
          Bus.publish(Operational.Debug, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "compat:postToolUse",
            msg: "legacy hook failed",
            context: { hook: "postToolUse", error },
          });
          return { action: "continue" };
        }
      },
    });
  }

  if (hooks.preTurn) {
    const fn = hooks.preTurn;
    registrations.push({
      name: "compat:preTurn",
      timing: "pre_turn",
      priority: 250,
      fn: async (ctx) => {
        try {
          return await fn(toHookContext(ctx));
        } catch (error) {
          Bus.publish(Operational.Debug, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "compat:preTurn",
            msg: "legacy hook failed",
            context: { hook: "preTurn", error },
          });
          return { action: "continue" };
        }
      },
    });
  }

  if (hooks.postTurn) {
    const fn = hooks.postTurn;
    registrations.push({
      name: "compat:postTurn",
      timing: "post_turn",
      priority: 250,
      fn: async (ctx) => {
        try {
          return await fn(toHookContext(ctx));
        } catch (error) {
          Bus.publish(Operational.Debug, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "compat:postTurn",
            msg: "legacy hook failed",
            context: { hook: "postTurn", error },
          });
          return { action: "continue" };
        }
      },
    });
  }

  if (hooks.onError) {
    const fn = hooks.onError;
    registrations.push({
      name: "compat:onError",
      timing: "on_error",
      priority: 250,
      fn: async (ctx) => {
        const maybeError = ctx.toolInput?.error;
        if (!(maybeError instanceof Error)) return { action: "continue" };
        try {
          return await fn({ ...toHookContext(ctx), error: maybeError });
        } catch (error) {
          Bus.publish(Operational.Debug, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "compat:onError",
            msg: "legacy hook failed",
            context: { hook: "onError", error },
          });
          return { action: "continue" };
        }
      },
    });
  }

  return registrations;
}

export type StepGuardFn = (
  step: AgentStep,
  ctx: StepGuardContext,
) => Promise<StepGuardVerdict> | StepGuardVerdict;

export function fromStepGuard(guard: StepGuardFn): MiddlewareRegistration {
  return {
    name: "compat:stepGuard",
    timing: "post_turn",
    priority: 250,
    fn: async (ctx) => {
      const lastStep = ctx.steps[ctx.steps.length - 1];
      if (!lastStep) return { action: "continue" };
      return guard(lastStep, toStepGuardContext(ctx));
    },
  };
}

export function fromConfig(config: {
  hooks?: ExecutionHooks;
  stepGuard?: StepGuardFn;
}): MiddlewareRegistration[] {
  const registrations: MiddlewareRegistration[] = [];

  if (config.hooks) {
    if (config.hooks.postTurn && config.stepGuard) {
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "compat:fromConfig",
        msg: "hooks.postTurn and stepGuard both set; hooks.postTurn takes precedence",
      });
    }
    registrations.push(...fromExecutionHooks(config.hooks));
  }

  if (config.stepGuard && !config.hooks?.postTurn) {
    registrations.push(fromStepGuard(config.stepGuard));
  }

  return registrations;
}
