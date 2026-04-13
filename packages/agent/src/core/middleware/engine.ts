import type { Hook, Middleware } from "@openomni/protocol";
import type { MiddlewareContext, MiddlewareRegistration } from "./types";

const CONTINUE: Hook.Verdict = { action: "continue" };

function matchesTiming(reg: MiddlewareRegistration, timing: Hook.Timing): boolean {
  return Array.isArray(reg.timing) ? reg.timing.includes(timing) : reg.timing === timing;
}

function matchesScope(reg: MiddlewareRegistration, agentType: string | undefined): boolean {
  const allowed = reg.scope?.agentType;
  if (!allowed || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

function selectRegistrations(
  registrations: MiddlewareRegistration[],
  timing: Hook.Timing,
  agentType: string | undefined,
): MiddlewareRegistration[] {
  return registrations
    .filter((reg) => matchesTiming(reg, timing) && matchesScope(reg, agentType))
    .sort((a, b) => a.priority - b.priority);
}

export interface MiddlewareEngineInstance {
  register(reg: MiddlewareRegistration): void;
  dispatch(timing: Hook.Timing, ctx: Omit<MiddlewareContext, "timing">): Promise<Hook.Verdict>;
  dispatchSystemPrompt(
    ctx: Omit<MiddlewareContext, "timing">,
  ): Promise<Middleware.SystemPromptVerdict>;
}

function create(): MiddlewareEngineInstance {
  const registrations: MiddlewareRegistration[] = [];

  async function dispatch(
    timing: Hook.Timing,
    ctx: Omit<MiddlewareContext, "timing">,
  ): Promise<Hook.Verdict> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: MiddlewareContext = { ...ctx, timing };

    for (const reg of selected) {
      let verdict: Hook.Verdict;
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const failPolicy = reg.failPolicy ?? "fail-open";
        if (failPolicy === "fail-closed") {
          return { action: "abort", reason: "middleware-error" };
        }
        console.warn(
          `[middleware:${reg.name}] threw error (fail-open, continuing): ${(err as Error).message}`,
        );
        continue;
      }

      if (verdict.action !== "continue") {
        return verdict;
      }
    }

    return CONTINUE;
  }

  async function dispatchSystemPrompt(
    ctx: Omit<MiddlewareContext, "timing">,
  ): Promise<Middleware.SystemPromptVerdict> {
    const selected = selectRegistrations(registrations, "on_system_prompt", ctx.agentType);
    const fullCtx: MiddlewareContext = { ...ctx, timing: "on_system_prompt" };

    let systemPrompt: string | undefined;
    const prependParts: string[] = [];
    const appendParts: string[] = [];

    for (const reg of selected) {
      let verdict: Hook.Verdict;
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const failPolicy = reg.failPolicy ?? "fail-open";
        if (failPolicy === "fail-closed") {
          throw err;
        }
        console.warn(
          `[middleware:${reg.name}] threw error (fail-open, continuing): ${(err as Error).message}`,
        );
        continue;
      }

      if (verdict.action === "transform") {
        const input = verdict.input as {
          systemPrompt?: unknown;
          prependContext?: unknown;
          appendContext?: unknown;
        };
        if (systemPrompt === undefined && typeof input.systemPrompt === "string") {
          systemPrompt = input.systemPrompt;
        }
        if (typeof input.prependContext === "string") {
          prependParts.push(input.prependContext);
        }
        if (typeof input.appendContext === "string") {
          appendParts.push(input.appendContext);
        }
      } else if (verdict.action === "inject") {
        appendParts.push(verdict.message);
      }
    }

    const result: Middleware.SystemPromptVerdict = {};
    if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
    if (prependParts.length > 0) result.prependContext = prependParts.join("\n\n");
    if (appendParts.length > 0) result.appendContext = appendParts.join("\n\n");
    return result;
  }

  return {
    register(reg) {
      registrations.push(reg);
    },
    dispatch,
    dispatchSystemPrompt,
  };
}

export const MiddlewareEngine = { create };
