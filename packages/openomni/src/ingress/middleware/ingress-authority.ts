import { PolicyEngine, type PolicyRegistration } from "@openomni/agent";
import { Policy, PolicyDecision, Ingress, type TraceContext } from "@openomni/protocol";
import type { ZodError } from "zod";
import type { CoordinatorLike } from "../coordinator-like";
import { resolveTarget, targetKey } from "../target";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type ActorRecord = Record<string, unknown>;

const workerControlActions = ["spawn", "send", "cancel", "resume", "schedule"] as const;
type WorkerControlAction = (typeof workerControlActions)[number];

const actionLabels: Record<WorkerControlAction, `action.${WorkerControlAction}`> = {
  spawn: "action.spawn",
  send: "action.send",
  cancel: "action.cancel",
  resume: "action.resume",
  schedule: "action.schedule",
};

interface PreRunState {
  readonly input: unknown;
  readonly coordinator?: CoordinatorLike;
  parsedEvent?: Ingress.InboundEvent;
  schemaError?: ZodError;
  mode?: Ingress.InboundEvent["mode"];
  target?: Ingress.Target;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function actorRole(actor: ActorRecord | undefined): string {
  return String(actor?.role ?? actor?.kind ?? actor?.type ?? "").toLowerCase();
}

function normalizeControlAction(value: unknown): WorkerControlAction | undefined {
  if (typeof value !== "string") return undefined;
  const action = value.toLowerCase();
  return workerControlActions.includes(action as WorkerControlAction)
    ? (action as WorkerControlAction)
    : undefined;
}

function inputAction(input: unknown): WorkerControlAction | undefined {
  const record = asRecord(input);
  return normalizeControlAction(record?.action);
}

function getEventAction(event: Ingress.InboundEvent): WorkerControlAction | undefined {
  const meta = asRecord(event.meta);
  return (
    normalizeControlAction(meta?.action) ??
    inputAction(meta?.input) ??
    inputAction(event.payload) ??
    inputAction(asRecord(event.payload)?.input)
  );
}

function targetRequiresCoordinator(target: Ingress.Target): boolean {
  return target.kind !== "resident";
}

function isTrustedManager(actor: ActorRecord): boolean {
  return actor.trusted === true || actor.isTrustedManager === true;
}

function isAuthorizedTopLevelActor(event: Ingress.InboundEvent): boolean {
  const actor = getActor(event);
  if (!actor) return false;

  const target = resolveTarget(event);
  const role = actorRole(actor);
  if (role === "user") return true;
  if (role === "resident") return true;
  if (role === "manager") return isTrustedManager(actor);
  if (role === "worker" && target.kind === "resident") return isTrustedManager(actor);

  return false;
}

function evaluateIngressAuthority(event: Ingress.InboundEvent): Policy.PolicyDecision {
  const target = resolveTarget(event);
  const actor = getActor(event);
  const role = actorRole(actor);
  const eventAction = getEventAction(event);
  const action = target.kind === "worker" ? "ingress.worker.deliver" : "ingress.top_level.create";
  const resource = `ingress.${event.surface}.${targetKey(target)}`;
  const resourceLabels = [
    `surface.${event.surface}`,
    `target.${target.kind}`,
    ...(role ? [`actor.${role}`] : []),
    ...(eventAction ? [actionLabels[eventAction]] : []),
  ];
  const decision = PolicyDecision.fromEvaluation(
    Policy.evaluate(
      {
        action,
        inputRules: [
          {
            toolPattern: resource,
            field: "actionPermission",
            pattern: "^worker\\.spawn$",
            action: "deny",
            reason: "worker cannot spawn workers",
            priority: 4,
          },
          {
            toolPattern: resource,
            field: "actionPermission",
            pattern: "^worker\\.cancel$",
            action: "deny",
            reason: "worker cannot cancel workers",
            priority: 4,
          },
          {
            toolPattern: resource,
            field: "actionPermission",
            pattern: "^worker\\.resume$",
            action: "deny",
            reason: "worker cannot resume workers",
            priority: 4,
          },
          {
            toolPattern: resource,
            field: "actionPermission",
            pattern: "^worker\\.schedule$",
            action: "deny",
            reason: "worker cannot schedule workers",
            priority: 4,
          },
          {
            toolPattern: resource,
            field: "actionPermission",
            pattern: "^resident\\.(spawn|send|cancel|resume|schedule)$",
            action: "allow",
            reason: "resident authorized for worker control action",
            priority: 3,
          },
          {
            toolPattern: resource,
            field: "actionPermission",
            pattern: "^worker\\.send$",
            action: "allow",
            reason: "worker authorized to send worker messages",
            priority: 3,
          },
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
        resourceLabels,
        actor,
        input: {
          actionPermission: eventAction ? `${role}.${eventAction}` : "",
          authorized: String(isAuthorizedTopLevelActor(event)),
        },
        metadata: { action: eventAction, mode: event.mode, surface: event.surface, target },
      },
    ),
  );

  return { ...decision, factsUsed: resourceLabels };
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
      const event = requireParsedEvent(state);
      const target = resolveTarget(event);
      state.target = target;

      if (!targetRequiresCoordinator(target)) {
        return allowDecision("ingress.coordinator", "coordinator not required for resident target");
      }
      if (state.coordinator === undefined) {
        return abortDecision(
          "ingress.coordinator",
          `coordinator is required for ${target.kind} target`,
        );
      }
      return allowDecision(
        "ingress.coordinator",
        `coordinator available for ${target.kind} target`,
      );
    },
  };
}

function createSchemaValidation(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityMiddleware.SchemaValidation,
    failPolicy: "fail-closed",
    fn: () => {
      const parsed = Ingress.DirectEventSchema.safeParse(state.input);
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
    priority: 10,
    failPolicy: "fail-closed",
  } as const satisfies Policy.Definition;

  export const SchemaValidation = {
    name: "ingress:schema-validation",
    timing: "run.start",
    priority: 0,
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
    priority: 35,
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
    readonly coordinator?: CoordinatorLike;
    readonly mode: Ingress.InboundEvent["mode"];
    readonly target: Ingress.Target;
  }

  export function registrations(state: PreRunState): PolicyRegistration[] {
    return [
      createSchemaValidation(state),
      createCoordinatorPresence(state),
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
    if (!state.parsedEvent || !state.mode) {
      throw new Error("ingress run.start middleware did not produce dispatch context");
    }
    const target = state.target ?? resolveTarget(state.parsedEvent);
    if (targetRequiresCoordinator(target) && !state.coordinator) {
      throw new Error("ingress run.start middleware did not produce coordinator for worker target");
    }

    return {
      event: state.parsedEvent,
      coordinator: state.coordinator,
      mode: state.mode,
      target,
    };
  }
}
