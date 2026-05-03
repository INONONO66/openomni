import {
  MiddlewareEngine,
  type MiddlewareDecision,
  type MiddlewareRegistration,
} from "@openomni/agent";
import { Ingress, type Hook, type Middleware, type TraceContext } from "@openomni/protocol";
import type { ZodError } from "zod";
import type { CoordinatorLike } from "../coordinator-like";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type ActorRecord = Record<string, unknown>;

interface PreRunState {
  readonly input: unknown;
  readonly coordinator?: CoordinatorLike;
  parsedEvent?: Ingress.InboundEvent;
  schemaError?: ZodError;
  mode?: Ingress.InboundEvent["mode"];
}

function continueVerdict(policyId: string, reason: string): Hook.Verdict {
  return { action: "continue", policyId, reason };
}

function abortVerdict(policyId: string, reason: string): Hook.Verdict {
  return { action: "abort", policyId, reason };
}

function getActor(event: Ingress.InboundEvent): ActorRecord | undefined {
  const actor = event.meta?.actor;
  return actor && typeof actor === "object" && !Array.isArray(actor)
    ? (actor as ActorRecord)
    : undefined;
}

function isTrustedManager(actor: ActorRecord): boolean {
  return actor.trusted === true || actor.isTrustedManager === true;
}

function isAuthorizedTopLevelActor(event: Ingress.InboundEvent): boolean {
  const actor = getActor(event);
  if (!actor) return true;

  const role = String(actor.role ?? actor.kind ?? actor.type ?? "").toLowerCase();
  if (role === "user") return true;
  if (role === "main" || role === "main_persona" || actor.isMain === true) return true;
  if (role === "manager") return isTrustedManager(actor);

  return false;
}

function requireParsedEvent(state: PreRunState): Ingress.InboundEvent {
  if (!state.parsedEvent) {
    throw new Error("ingress event must be schema-validated before authority middleware");
  }
  return state.parsedEvent;
}

function createCoordinatorPresence(state: PreRunState): MiddlewareRegistration {
  return {
    ...IngressAuthorityMiddleware.CoordinatorPresence,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.coordinator === undefined) {
        return abortVerdict("ingress.coordinator", "coordinator is required");
      }
      return continueVerdict("ingress.coordinator", "coordinator available");
    },
  };
}

function createSchemaValidation(state: PreRunState): MiddlewareRegistration {
  return {
    ...IngressAuthorityMiddleware.SchemaValidation,
    failPolicy: "fail-closed",
    fn: () => {
      const parsed = Ingress.InboundEventSchema.safeParse(state.input);
      if (!parsed.success) {
        state.schemaError = parsed.error;
        return abortVerdict("ingress.schema", "invalid ingress event");
      }

      state.parsedEvent = parsed.data;
      return continueVerdict("ingress.schema", "ingress event schema valid");
    },
  };
}

function createAuthorityCheck(state: PreRunState): MiddlewareRegistration {
  return {
    ...IngressAuthorityMiddleware.AuthorityCheck,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);

      // Guardrail.evaluate is resource-pattern based; this boundary is actor role/trust policy.
      if (!isAuthorizedTopLevelActor(event)) {
        return abortVerdict(
          "ingress.authority",
          "actor is not authorized to create top-level inbound work",
        );
      }

      return continueVerdict("ingress.authority", "actor authorized for top-level inbound work");
    },
  };
}

function createModeDispatch(state: PreRunState): MiddlewareRegistration {
  return {
    ...IngressAuthorityMiddleware.ModeDispatch,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);
      if (event.mode !== "plan" && event.mode !== "direct") {
        const unknownMode = (event as { mode: unknown }).mode;
        return abortVerdict("ingress.mode", `unknown ingress mode: ${unknownMode}`);
      }

      state.mode = event.mode;
      return continueVerdict("ingress.mode", `dispatch mode ${event.mode}`);
    },
  };
}

function throwAbort(verdict: Hook.Verdict, state: PreRunState): never {
  if (state.schemaError) throw state.schemaError;
  throw new Error(verdict.reason ?? "ingress pre_run middleware aborted");
}

export namespace IngressAuthorityMiddleware {
  export const CoordinatorPresence = {
    name: "ingress:coordinator-presence",
    timing: "pre_run",
    priority: 0,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const SchemaValidation = {
    name: "ingress:schema-validation",
    timing: "pre_run",
    priority: 10,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const AuthorityCheck = {
    name: "ingress:authority",
    timing: "pre_run",
    priority: 20,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export const ModeDispatch = {
    name: "ingress:mode-dispatch",
    timing: "pre_run",
    priority: 30,
    failPolicy: "fail-closed",
  } satisfies Middleware.Definition;

  export interface PreRunContext {
    readonly event: Ingress.InboundEvent;
    readonly coordinator?: CoordinatorLike;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  }

  export interface PreRunResult {
    readonly event: Ingress.InboundEvent;
    readonly coordinator: CoordinatorLike;
    readonly mode: Ingress.InboundEvent["mode"];
  }

  export function registrations(state: PreRunState): MiddlewareRegistration[] {
    return [
      createCoordinatorPresence(state),
      createSchemaValidation(state),
      createAuthorityCheck(state),
      createModeDispatch(state),
    ];
  }

  export async function runPreRun(ctx: PreRunContext): Promise<PreRunResult> {
    const state: PreRunState = { input: ctx.event, coordinator: ctx.coordinator };
    const engine = MiddlewareEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const verdict = await engine.dispatch("pre_run", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolInput: { event: ctx.event },
      traceContext: ctx.traceContext,
    });

    if (verdict.action !== "continue") throwAbort(verdict, state);
    if (!state.parsedEvent || !state.coordinator || !state.mode) {
      throw new Error("ingress pre_run middleware did not produce dispatch context");
    }

    return {
      event: state.parsedEvent,
      coordinator: state.coordinator,
      mode: state.mode,
    };
  }
}
