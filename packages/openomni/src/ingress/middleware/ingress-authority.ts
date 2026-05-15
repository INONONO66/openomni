import { PolicyEngine, type PolicyRegistration } from "@openomni/agent";
import { Policy, PolicyDecision, Ingress, type TraceContext } from "@openomni/protocol";
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

function allowDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason] });
}

function abortDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId,
    reasonCodes: [reason],
    effects: [{ type: "run.abort", reason }],
  });
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

function evaluateIngressAuthority(event: Ingress.InboundEvent): Policy.PolicyDecision {
  const action = "ingress.top_level.create";
  const resource = `ingress.${event.surface}`;
  return PolicyDecision.fromEvaluation(
    Policy.evaluate(
      {
        action,
        inputRules: [
          {
            toolPattern: resource,
            field: "authorized",
            pattern: "^true$",
            action: "allow",
            reason: "actor authorized for top-level inbound work",
            priority: 2,
          },
          {
            toolPattern: resource,
            field: "authorized",
            pattern: "^false$",
            action: "deny",
            reason: "actor is not authorized to create top-level inbound work",
            priority: 1,
          },
        ],
      },
      {
        action,
        resource,
        actor: getActor(event),
        input: { authorized: String(isAuthorizedTopLevelActor(event)) },
        metadata: { mode: event.mode, surface: event.surface },
      },
    ),
  );
}

function requireParsedEvent(state: PreRunState): Ingress.InboundEvent {
  if (!state.parsedEvent) {
    throw new Error("ingress event must be schema-validated before authority middleware");
  }
  return state.parsedEvent;
}

function createCoordinatorPresence(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityMiddleware.CoordinatorPresence,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.coordinator === undefined) {
        return abortDecision("ingress.coordinator", "coordinator is required");
      }
      return allowDecision("ingress.coordinator", "coordinator available");
    },
  };
}

function createSchemaValidation(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityMiddleware.SchemaValidation,
    failPolicy: "fail-closed",
    fn: () => {
      const parsed = Ingress.InboundEventSchema.safeParse(state.input);
      if (!parsed.success) {
        state.schemaError = parsed.error;
        return abortDecision("ingress.schema", "invalid ingress event");
      }

      state.parsedEvent = parsed.data;
      return allowDecision("ingress.schema", "ingress event schema valid");
    },
  };
}

function createAuthorityCheck(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityMiddleware.AuthorityCheck,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);

      return evaluateIngressAuthority(event);
    },
  };
}

function createModeDispatch(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityMiddleware.ModeDispatch,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);
      if (event.mode !== "direct") {
        const unknownMode = (event as { mode: unknown }).mode;
        return abortDecision("ingress.mode", `unknown ingress mode: ${unknownMode}`);
      }

      state.mode = event.mode;
      return allowDecision("ingress.mode", `dispatch mode ${event.mode}`);
    },
  };
}

function throwAbort(decision: Policy.PolicyDecision, state: PreRunState): never {
  if (state.schemaError) throw state.schemaError;
  throw new Error(PolicyDecision.reason(decision, "ingress run.start middleware aborted"));
}

export namespace IngressAuthorityMiddleware {
  export const CoordinatorPresence = {
    name: "ingress:coordinator-presence",
    timing: "run.start",
    priority: 0,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const SchemaValidation = {
    name: "ingress:schema-validation",
    timing: "run.start",
    priority: 10,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const AuthorityCheck = {
    name: "ingress:authority",
    timing: "run.start",
    priority: 20,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const ModeDispatch = {
    name: "ingress:mode-dispatch",
    timing: "run.start",
    priority: 30,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export interface PreRunContext {
    readonly event: Ingress.InboundEvent;
    readonly coordinator?: CoordinatorLike;
    readonly traceContext?: TraceContext.Type;
    readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  }

  export interface PreRunResult {
    readonly event: Ingress.InboundEvent;
    readonly coordinator: CoordinatorLike;
    readonly mode: Ingress.InboundEvent["mode"];
  }

  export function registrations(state: PreRunState): PolicyRegistration[] {
    return [
      createCoordinatorPresence(state),
      createSchemaValidation(state),
      createAuthorityCheck(state),
      createModeDispatch(state),
    ];
  }

  export async function runPreRun(ctx: PreRunContext): Promise<PreRunResult> {
    const state: PreRunState = { input: ctx.event, coordinator: ctx.coordinator };
    const engine = PolicyEngine.create({
      traceContext: ctx.traceContext,
      onDecision: ctx.onDecision,
    });

    for (const registration of registrations(state)) {
      engine.register(registration);
    }

    const decision = await engine.dispatch("run.start", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolInput: { event: ctx.event },
      traceContext: ctx.traceContext,
    });

    if (PolicyDecision.isBlocking(decision)) throwAbort(decision, state);
    if (!state.parsedEvent || !state.coordinator || !state.mode) {
      throw new Error("ingress run.start middleware did not produce dispatch context");
    }

    return {
      event: state.parsedEvent,
      coordinator: state.coordinator,
      mode: state.mode,
    };
  }
}
