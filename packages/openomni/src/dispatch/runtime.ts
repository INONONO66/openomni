import { PolicyEngine, type PolicyDecision } from "@openomni/policy";
import { Command, PolicyDecision as Decision } from "@openomni/protocol";
import { PendingInteractionStore, Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import { requestedWaitAction, type RequestedWaitAction } from "../wait/index.js";
import { deriveActorContext, type DispatchRuntimeContext } from "./actor.js";
import { routePendingInteraction } from "./pending-interaction-routing.js";
import { createDefaultDispatchPolicy, type DispatchPolicyContext } from "./policy.js";
import { registerDispatchPolicy, type DispatchPolicyRegistration } from "./policy-registration.js";
import { DispatchRegistry, type DispatchHandler, type DispatchHandlerContext } from "./registry.js";
import {
  eventBase,
  normalizeHandlerOutput,
  policyTraceContext,
  resourceDescriptor,
} from "./runtime-support.js";

/**
 * What a submit needs beyond the input. The trace is required and separated
 * from the optional bag on purpose: a caller that forgets it is a compile
 * error, not a review round. Rounds 5-7 of #606 each shipped a required
 * `traceId` on a schema that a caller could still satisfy by omission, and
 * each was found by reading rather than by the compiler.
 */
export type DispatchSubmitOptions = DispatchSubmitContext & { readonly traceId: string };

interface DispatchSubmitContext extends DispatchRuntimeContext, DispatchHandlerContext {
  readonly policies?: readonly DispatchPolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
  readonly sourceTool?: string;
}

export interface DispatchRuntimeOptions {
  readonly registry?: DispatchRegistry;
  readonly policies?: readonly DispatchPolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
}

function collectPolicies(
  runtimePolicies: readonly DispatchPolicyRegistration[],
  submitPolicies: readonly DispatchPolicyRegistration[] | undefined,
  includeDefaultPolicies: boolean,
): DispatchPolicyRegistration[] {
  return [
    ...(includeDefaultPolicies ? [createDefaultDispatchPolicy()] : []),
    ...runtimePolicies,
    ...(submitPolicies ?? []),
  ];
}

export type CommandRecordErrorCode = "command_record_failed";

/**
 * #510 C3 ruling 2 — recording the dispatch verdict failed, so the verdict
 * must not act (no record, no action): a missing ledger sub-adapter, a failed
 * append, or a verdict stream that already has a head. There is NO replay
 * semantics here: `dispatchId` is minted fresh per submit, so a head conflict
 * can only mean id collision or ledger corruption — it fails closed as a
 * record failure, it does not detect duplicates.
 */
export class CommandRecordError extends Error {
  readonly code: CommandRecordErrorCode;
  readonly dispatchId: string;

  constructor(code: CommandRecordErrorCode, dispatchId: string, message: string) {
    super(message);
    this.name = "CommandRecordError";
    this.code = code;
    this.dispatchId = dispatchId;
  }
}

type CommandVerdictFact = Readonly<{
  type: "command.authorized" | "command.denied";
  verdict: "allow" | "deny" | "pending";
  policyId: string;
  reason: string;
}>;

// The authorization verdict is a decision-class fact on the single-fact
// owner stream `command:<dispatchId>` (expectedHead 0), appended durably
// BEFORE the verdict acts: command.authorized precedes handler invocation,
// command.denied precedes the denial result, and the observe-only Bus
// Events.Authorized/Denied publishes follow the append. Fact data fields
// come from the parsed Command and the policy decision — that parse is the
// one enforcement layer; the payload vocabulary is
// Ledger.CommandAuthorized/CommandDenied (@openomni/protocol).
function appendCommandVerdict(command: Command.Request, fact: CommandVerdictFact): void {
  const ledger = Storage.get().ledger;
  if (!ledger) {
    throw new CommandRecordError(
      "command_record_failed",
      command.dispatchId,
      "Storage adapter does not implement ledger append — dispatch verdicts fail closed",
    );
  }
  let appended: ReturnType<typeof ledger.append>;
  try {
    appended = ledger.append(
      {
        streamId: `command:${command.dispatchId}`,
        type: fact.type,
        data: {
          verdict: fact.verdict,
          policyId: fact.policyId,
          reason: fact.reason,
          actorKind: command.actor.kind,
          action: command.action,
          targetKind: command.target.kind,
        },
      },
      0,
    );
  } catch (error) {
    throw new CommandRecordError(
      "command_record_failed",
      command.dispatchId,
      `dispatch verdict append failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (appended.kind === "cas_conflict") {
    // Unreachable for a fresh dispatchId; reachable only by id collision or
    // a corrupted stream head — a record failure, not a detected replay.
    throw new CommandRecordError(
      "command_record_failed",
      command.dispatchId,
      `dispatch verdict stream for ${command.dispatchId} already has a head — fail closed`,
    );
  }
}

type PinnedInteractionValidation =
  | { readonly record: PendingInteractionStore.Record }
  | { readonly reason: string };

function revalidatePinnedInteraction(
  pinned: PendingInteractionStore.Record,
  requestedAction: RequestedWaitAction,
  now = Date.now(),
): PinnedInteractionValidation {
  const current = PendingInteractionStore.get(pinned.id);
  if (!current) return { reason: "dispatch.pending_interaction.not_found" };

  const active =
    (current.status === "open" && now <= current.expiresAt) ||
    ((current.status === "resolved" || current.status === "follow_up") &&
      current.resolvedAt !== undefined &&
      now <= current.resolvedAt + current.followUpWindow);
  if (!active) return { reason: "dispatch.pending_interaction.inactive" };

  if (
    current.createdAt !== pinned.createdAt ||
    current.endpointId !== pinned.endpointId ||
    current.channelId !== pinned.channelId ||
    current.targetActorId !== pinned.targetActorId ||
    current.correlation.replyToMessageId !== pinned.correlation.replyToMessageId ||
    current.correlation.threadId !== pinned.correlation.threadId ||
    current.correlation.tokenHash !== pinned.correlation.tokenHash ||
    current.correlation.externalConversationId !== pinned.correlation.externalConversationId
  ) {
    return { reason: "dispatch.pending_interaction.identity_mismatch" };
  }
  if (current.sessionId !== pinned.sessionId) {
    return { reason: "dispatch.pending_interaction.session_mismatch" };
  }
  if (current.workerRunId !== pinned.workerRunId) {
    return { reason: "dispatch.pending_interaction.run_mismatch" };
  }
  // The "invalid" sentinel (explicit but unparseable action) is a member of
  // no allowedActions list — it denies exactly like any other disallowed
  // action instead of coercing to the report_result default.
  if (requestedAction === "invalid" || !current.allowedActions.includes(requestedAction)) {
    return { reason: "dispatch.pending_interaction.action.denied" };
  }
  return { record: current };
}

function denyStalePinnedInteraction(
  command: Command.Request,
  start: number,
  reason: string,
): Command.Result {
  appendCommandVerdict(command, {
    type: "command.denied",
    verdict: "deny",
    policyId: "dispatch.pending-interaction-revalidation",
    reason,
  });
  Bus.publish(Command.Events.Denied, {
    ...eventBase(command),
    verdict: "deny",
    reason,
    policyId: "dispatch.pending-interaction-revalidation",
    effects: [],
  });
  return Command.Result.parse({
    dispatchId: command.dispatchId,
    status: "denied",
    reason,
    error: reason,
    durationMs: Date.now() - start,
  });
}

const submitPinnedInteraction = Symbol("submitPinnedInteraction");

export function submitPinnedPendingInteraction(
  runtime: DispatchRuntime,
  input: Command.Input,
  pendingInteraction: PendingInteractionStore.Record,
  options: DispatchSubmitOptions,
): Promise<Command.Result> {
  return runtime[submitPinnedInteraction](input, pendingInteraction, options);
}

export class DispatchRuntime {
  readonly registry: DispatchRegistry;
  private readonly policies: readonly DispatchPolicyRegistration[];
  private readonly includeDefaultPolicies: boolean;
  private readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;

  constructor(options: DispatchRuntimeOptions = {}) {
    this.registry = options.registry ?? new DispatchRegistry();
    this.policies = options.policies ?? [];
    this.includeDefaultPolicies = options.includeDefaultPolicies ?? true;
    this.onPolicyDecision = options.onPolicyDecision;
  }

  register(action: string, handler: DispatchHandler): () => void {
    return this.registry.register(action, handler);
  }

  async submit(input: Command.Input, options: DispatchSubmitOptions): Promise<Command.Result> {
    return this.submitResolved(input, options);
  }

  async [submitPinnedInteraction](
    input: Command.Input,
    pendingInteraction: PendingInteractionStore.Record,
    options: DispatchSubmitOptions,
  ): Promise<Command.Result> {
    return this.submitResolved(input, options, pendingInteraction);
  }

  private async submitResolved(
    input: Command.Input,
    options: DispatchSubmitOptions,
    pendingInteraction?: PendingInteractionStore.Record,
  ): Promise<Command.Result> {
    const parsed = Command.Input.parse(input);
    // The type makes this unreachable for a typed caller; it stands for the
    // untyped ones (`Reflect.apply`, JSON-shaped IPC params).
    if (options.traceId === undefined || options.traceId.length === 0) {
      throw new Error("dispatch submit requires the ordering run's traceId");
    }
    const trace = { traceId: options.traceId };
    const actor = deriveActorContext(options);
    const requestedPendingAction = requestedWaitAction(parsed.payload);
    const initialPinnedValidation = pendingInteraction
      ? revalidatePinnedInteraction(pendingInteraction, requestedPendingAction)
      : undefined;
    const activePinnedInteraction =
      initialPinnedValidation && "record" in initialPinnedValidation
        ? initialPinnedValidation.record
        : undefined;
    const command = routePendingInteraction(
      Command.Request.parse({
        ...parsed,
        dispatchId: crypto.randomUUID(),
        actor,
        traceId: trace.traceId,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        submittedAt: Date.now(),
      }),
      activePinnedInteraction,
    );
    const start = Date.now();

    Bus.publish(Command.Events.Submitted, {
      ...eventBase(command),
      ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
    });

    const engine = PolicyEngine.create<DispatchPolicyContext>({
      traceContext: policyTraceContext(command),
      onDecision: options.onPolicyDecision ?? this.onPolicyDecision,
      auditEmit: Bus.publish,
    });
    for (const reg of collectPolicies(
      this.policies,
      options.policies,
      options.includeDefaultPolicies ?? this.includeDefaultPolicies,
    )) {
      registerDispatchPolicy(engine, reg);
    }

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      actor: command.actor,
      dispatchId: command.dispatchId,
      action: command.action,
      target: command.target,
      ...(command.correlation !== undefined && { correlation: command.correlation }),
      ...(command.sessionId !== undefined && { sessionId: command.sessionId }),
      ...(command.runId !== undefined && { runId: command.runId }),
      labels: [
        { value: `dispatch.${command.action}`, source: "system" },
        { value: `actor.${command.actor.kind}`, source: "system" },
        { value: `target.${command.target.kind}`, source: "system" },
      ],
      resourceDescriptor: resourceDescriptor(command.action),
      traceContext: policyTraceContext(command),
    });

    if (Decision.isBlocking(decision)) {
      const reason = Decision.reason(decision, "dispatch.authorize denied");
      const verdict = decision.verdict === "pending" ? "pending" : "deny";
      appendCommandVerdict(command, {
        type: "command.denied",
        verdict,
        policyId: decision.policyId,
        reason,
      });
      Bus.publish(Command.Events.Denied, {
        ...eventBase(command),
        verdict,
        reason,
        policyId: decision.policyId,
        effects: decision.effects,
      });
      return Command.Result.parse({
        dispatchId: command.dispatchId,
        status: "denied",
        reason,
        error: reason,
        durationMs: Date.now() - start,
      });
    }

    if (pendingInteraction) {
      const validation = revalidatePinnedInteraction(pendingInteraction, requestedPendingAction);
      if ("reason" in validation) {
        return denyStalePinnedInteraction(command, start, validation.reason);
      }
    }

    appendCommandVerdict(command, {
      type: "command.authorized",
      verdict: "allow",
      policyId: decision.policyId,
      reason: Decision.reason(decision, "dispatch.authorize allowed"),
    });
    Bus.publish(Command.Events.Authorized, {
      ...eventBase(command),
      verdict: "allow",
      reason: Decision.reason(decision, "dispatch.authorize allowed"),
      policyId: decision.policyId,
      effects: decision.effects,
    });

    const handler = this.registry.get(command.action);
    if (!handler) {
      const reason = `No dispatch handler registered for ${command.action}`;
      Bus.publish(Command.Events.Failed, {
        ...eventBase(command),
        durationMs: Date.now() - start,
        reason,
      });
      return Command.Result.parse({
        dispatchId: command.dispatchId,
        status: "failed",
        error: reason,
        durationMs: Date.now() - start,
      });
    }

    // #548: routing a frozen legacy PendingInteraction match records no state
    // transition — the store is read-only and correlation is gated at read
    // time, so the routed command is the only trace the match leaves here.
    Bus.publish(Command.Events.Routed, { ...eventBase(command), handler: command.action });

    try {
      const raw = await handler(command, {
        signal: options.signal,
        ...((options.wait ?? command.wait) !== undefined
          ? { wait: options.wait ?? command.wait }
          : {}),
        ...((options.timeoutMs ?? command.timeoutMs) !== undefined
          ? { timeoutMs: options.timeoutMs ?? command.timeoutMs }
          : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.sourceTool ? { sourceTool: options.sourceTool } : {}),
      });
      const output = normalizeHandlerOutput(raw);
      Bus.publish(Command.Events.Completed, {
        ...eventBase(command),
        handler: command.action,
        durationMs: Date.now() - start,
      });
      return Command.Result.parse({
        dispatchId: command.dispatchId,
        status: "completed",
        output,
        handler: command.action,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      Bus.publish(Command.Events.Failed, {
        ...eventBase(command),
        handler: command.action,
        durationMs: Date.now() - start,
        reason,
      });
      return Command.Result.parse({
        dispatchId: command.dispatchId,
        status: "failed",
        error: reason,
        handler: command.action,
        durationMs: Date.now() - start,
      });
    }
  }
}
