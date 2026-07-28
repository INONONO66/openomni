import { Execution, Model, type Ledger } from "@openomni/protocol";
import {
  ScheduleService,
  type ScheduleNativeCommand,
  type ScheduleQuery,
  type ScheduleQueryResult,
  type ScheduleTransitionResult,
} from "../../execution-runtime/schedule-service.js";

export type EffectSettlementV1 =
  | "pending"
  | "confirmed"
  | "definite_failed"
  | "unknown"
  | "manually_resolved";

export type EffectSettlementInputV1 = "confirmed" | "failed" | "unknown" | "manually_resolved";

export interface AttemptExecutionRowV1 {
  readonly ownerKey: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly state: {
    readonly runId: string;
    readonly attemptSeq: number;
    readonly status:
      | "allocated"
      | "starting"
      | "running"
      | "waiting"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "interrupted";
    readonly environment: Execution.LLMEnvironmentV1;
  };
}

export interface EffectRowV1 {
  readonly ownerKey: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly sourceEventId: string;
  readonly state: {
    readonly effectId: string;
    readonly sourceRef: string;
    readonly operation: "connector.submit.v1";
    readonly settlement: EffectSettlementV1;
    readonly attempt: Ledger.AttemptRefV1;
    readonly scope: Execution.EffectScopeV1;
  };
}

export interface MessageRecoveryRowV1 {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly state: {
    readonly status: string;
    readonly surfaceId?: string;
    readonly role?: string;
    readonly model?: unknown;
  };
}

export interface EffectIntentInputV1 {
  readonly version: "tool-effect-intent-v1";
  readonly effectId: string;
  readonly sourceRef: string;
  readonly operation: string;
  readonly toolCallId: string;
  readonly execution?: { readonly sessionId: string; readonly runId: string };
  readonly scope: Execution.EffectScopeV1;
}

export interface EffectSettlementRequestV1 {
  readonly version: "tool-effect-settlement-v1";
  readonly effectId: string;
  readonly sourceRef: string;
  readonly status: EffectSettlementInputV1;
}

export type EffectAppendReceiptV1 =
  | {
      readonly version: "tool-effect-append-receipt-v1";
      readonly status: "accepted";
      readonly receiptId: string;
    }
  | {
      readonly version: "tool-effect-append-receipt-v1";
      readonly status: "rejected";
      readonly reason: string;
    };

export type ScheduleEffectIncidentV1 = Readonly<{
  version: "production-schedule-effect-incident-v1";
  code:
    | "effect_intent_mismatch"
    | "effect_scope_unresolved"
    | "effect_settlement_without_intent"
    | "effect_illegal_settlement"
    | "recovery_transition_rejected";
  subjectId: string;
}>;

export interface ProductionScheduleEffectDependencies {
  readonly workspaceId: string;
  readonly schedule: {
    execute(command: ScheduleNativeCommand): Promise<ScheduleTransitionResult>;
    query(request: ScheduleQuery): Promise<ScheduleQueryResult>;
  };
  readonly queries: {
    effect(effectId: string): Promise<EffectRowV1 | undefined>;
    attemptByRunId(runId: string): Promise<AttemptExecutionRowV1 | undefined>;
    interruptedAttempts(): Promise<readonly AttemptExecutionRowV1[]>;
    interruptedMessages(): Promise<readonly MessageRecoveryRowV1[]>;
    message(messageId: string): Promise<MessageRecoveryRowV1 | undefined>;
  };
  readonly effects: {
    recordIntent(
      input: Readonly<{
        transitionId: "DP-06";
        ownerKey: string;
        dispatchId: string;
        sessionId: string;
        attempt: Ledger.AttemptRefV1;
        environment: Execution.LLMEnvironmentV1;
        effectId: string;
        sourceRef: string;
        operation: "connector.submit.v1";
        scope: Execution.EffectScopeV1;
        requestId: string;
      }>,
    ): Promise<{ readonly receiptId: string }>;
    recordSettlement(
      input: Readonly<{
        transitionId: "EF-01" | "EF-02" | "EF-03" | "EF-04";
        ownerKey: string;
        attempt: Ledger.AttemptRefV1;
        effectId: string;
        sourceRef: string;
        scope: Execution.EffectScopeV1;
        settlement: Exclude<EffectSettlementV1, "pending">;
        requestId: string;
      }>,
    ): Promise<{ readonly receiptId: string }>;
  };
  readonly recovery: {
    interruptAttempt(
      input: Readonly<{
        transitionId: "AT-06" | "AT-11" | "AT-15";
        attempt: Ledger.AttemptRefV1;
        reason: "server restart";
        requestId: string;
      }>,
    ): Promise<"committed" | "conflict">;
    failStreamingMessage(
      input: Readonly<{
        transitionId: "MS-07";
        ownerKey: string;
        sessionId: string;
        messageId: string;
        surfaceId: string;
        role: string;
        model: unknown;
        requestId: string;
      }>,
    ): Promise<"committed" | "conflict">;
  };
  readonly incidents: { report(incident: ScheduleEffectIncidentV1): void };
  readonly now?: () => number;
}

export interface ProductionScheduleEffectServices {
  readonly schedule: ScheduleService;
  readonly effects: {
    appendIntent(input: EffectIntentInputV1): Promise<EffectAppendReceiptV1>;
    appendSettlement(input: EffectSettlementRequestV1): Promise<EffectAppendReceiptV1>;
  };
  readonly recovery: {
    readonly runs: {
      interruptedRuns(): Promise<readonly AttemptExecutionRowV1[]>;
      interruptRun(input: {
        readonly sessionId: string;
        readonly runId: string;
      }): Promise<"recovered" | "unchanged">;
    };
    readonly messages: {
      interruptedMessages(): Promise<
        readonly { readonly sessionId: string; readonly messageId: string }[]
      >;
      reconcileInterruptedMessage(input: {
        readonly sessionId: string;
        readonly messageId: string;
        readonly requestId?: string;
      }): Promise<"recovered" | "unchanged">;
    };
  };
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

function attemptRef(row: AttemptExecutionRowV1): Ledger.AttemptRefV1 {
  return {
    version: "attempt-ref-v1",
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    attemptSeq: row.state.attemptSeq,
  };
}

function rejected(reason: string): EffectAppendReceiptV1 {
  return { version: "tool-effect-append-receipt-v1", status: "rejected", reason };
}

function accepted(receiptId: string): EffectAppendReceiptV1 {
  return { version: "tool-effect-append-receipt-v1", status: "accepted", receiptId };
}

function report(
  deps: ProductionScheduleEffectDependencies,
  code: ScheduleEffectIncidentV1["code"],
  subjectId: string,
): void {
  deps.incidents.report({ version: "production-schedule-effect-incident-v1", code, subjectId });
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | {
      readonly [key: string]: CanonicalJson;
    };

function canonicalJson(value: unknown): CanonicalJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object") throw new TypeError("effect scope is not canonical JSON");
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function sameAttempt(left: Ledger.AttemptRefV1, right: Ledger.AttemptRefV1): boolean {
  return (
    left.workItemId === right.workItemId &&
    left.attemptId === right.attemptId &&
    left.attemptSeq === right.attemptSeq
  );
}

function scopeMatchesOperation(
  scope: Execution.EffectScopeV1,
  operation: "connector.submit.v1",
  workspaceId: string,
): boolean {
  const parsed = Execution.EffectScopeV1.safeParse(scope);
  if (!parsed.success || parsed.data.workspace.workspaceId !== workspaceId) return false;
  switch (operation) {
    case "connector.submit.v1": {
      const kinds = parsed.data.resources.map(({ kind }) => kind);
      return (
        parsed.data.resolver.id === "connector-installation-v1" &&
        parsed.data.resolver.version === "1" &&
        parsed.data.containment === "connector-declared" &&
        parsed.data.mutationClass === "unknown" &&
        kinds.length === 2 &&
        kinds[0] === "connector" &&
        kinds[1] === "endpoint"
      );
    }
  }
}

function messageRecoveryFacts(
  row: MessageRecoveryRowV1,
):
  | { readonly surfaceId: string; readonly role: string; readonly model: Model.Ref | null }
  | undefined {
  if (row.state.surfaceId === undefined || row.state.surfaceId.length === 0) return undefined;
  if (
    row.state.role !== "user" &&
    row.state.role !== "assistant" &&
    row.state.role !== "system" &&
    row.state.role !== "tool"
  )
    return undefined;
  if (row.state.model === null) {
    return { surfaceId: row.state.surfaceId, role: row.state.role, model: null };
  }
  const model = Model.Ref.strict().safeParse(row.state.model);
  return model.success && model.data.provider.length > 0 && model.data.id.length > 0
    ? { surfaceId: row.state.surfaceId, role: row.state.role, model: model.data }
    : undefined;
}

function sameScope(left: Execution.EffectScopeV1, right: Execution.EffectScopeV1): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function settlement(input: EffectSettlementInputV1): Exclude<EffectSettlementV1, "pending"> {
  switch (input) {
    case "confirmed":
      return "confirmed";
    case "failed":
      return "definite_failed";
    case "unknown":
      return "unknown";
    case "manually_resolved":
      return "manually_resolved";
  }
}

function settlementTransition(
  value: Exclude<EffectSettlementV1, "pending">,
): "EF-01" | "EF-02" | "EF-03" | "EF-04" {
  switch (value) {
    case "confirmed":
      return "EF-01";
    case "definite_failed":
      return "EF-02";
    case "unknown":
      return "EF-03";
    case "manually_resolved":
      return "EF-04";
  }
}

function createEffectService(deps: ProductionScheduleEffectDependencies) {
  return Object.freeze({
    async appendIntent(input: EffectIntentInputV1): Promise<EffectAppendReceiptV1> {
      if (
        !input.effectId ||
        !input.sourceRef ||
        input.operation !== "connector.submit.v1" ||
        input.execution === undefined
      ) {
        report(deps, "effect_intent_mismatch", input.effectId);
        return rejected("operation has no exact intent-producing native transition");
      }
      const row = await deps.queries.attemptByRunId(input.execution.runId);
      const environment =
        row === undefined ? undefined : Execution.LLMEnvironmentV1.safeParse(row.state.environment);
      if (
        row === undefined ||
        row.sessionId !== input.execution.sessionId ||
        row.state.runId !== input.execution.runId ||
        environment === undefined ||
        !environment.success ||
        !scopeMatchesOperation(input.scope, input.operation, deps.workspaceId)
      ) {
        report(deps, "effect_scope_unresolved", input.effectId);
        return rejected(
          "effect intent immutable Attempt, environment, operation, or workspace scope is unresolved",
        );
      }
      const authoritativeAttempt = attemptRef(row);
      const existing = await deps.queries.effect(input.effectId);
      if (existing !== undefined) {
        if (
          existing.ownerKey !== row.ownerKey ||
          existing.workItemId !== row.workItemId ||
          existing.attemptId !== row.attemptId ||
          existing.state.sourceRef !== input.sourceRef ||
          existing.state.operation !== input.operation ||
          existing.state.settlement !== "pending" ||
          !scopeMatchesOperation(
            existing.state.scope,
            existing.state.operation,
            deps.workspaceId,
          ) ||
          !sameAttempt(existing.state.attempt, authoritativeAttempt) ||
          !sameScope(existing.state.scope, input.scope)
        ) {
          report(deps, "effect_intent_mismatch", input.effectId);
          return rejected("effect intent is not the exact pending durable intent");
        }
        return accepted(existing.sourceEventId);
      }
      if (row.state.status !== "running") {
        report(deps, "effect_scope_unresolved", input.effectId);
        return rejected(
          "effect intent immutable Attempt, environment, operation, or workspace scope is unresolved",
        );
      }
      const receipt = await deps.effects.recordIntent({
        transitionId: "DP-06",
        ownerKey: row.ownerKey,
        dispatchId: nonEmpty(input.toolCallId, "toolCallId"),
        sessionId: row.sessionId,
        attempt: authoritativeAttempt,
        environment: environment.data,
        effectId: input.effectId,
        sourceRef: input.sourceRef,
        operation: input.operation,
        scope: input.scope,
        requestId: `effect:intent:${input.effectId}`,
      });
      return accepted(receipt.receiptId);
    },

    async appendSettlement(input: EffectSettlementRequestV1): Promise<EffectAppendReceiptV1> {
      const row = await deps.queries.effect(input.effectId);
      if (row === undefined || row.state.sourceRef !== input.sourceRef) {
        report(deps, "effect_settlement_without_intent", input.effectId);
        return rejected("authoritative effect intent not found");
      }
      const next = settlement(input.status);
      if (row.state.settlement === next) return accepted(row.sourceEventId);
      const legal =
        (row.state.settlement === "pending" && next !== "manually_resolved") ||
        (row.state.settlement === "unknown" && next === "manually_resolved");
      if (!legal) {
        report(deps, "effect_illegal_settlement", input.effectId);
        return rejected("effect settlement is not a legal exact lifecycle edge");
      }
      const receipt = await deps.effects.recordSettlement({
        transitionId: settlementTransition(next),
        ownerKey: row.ownerKey,
        attempt: row.state.attempt,
        effectId: input.effectId,
        sourceRef: input.sourceRef,
        scope: row.state.scope,
        settlement: next,
        requestId: `effect:${input.effectId}:${next}`,
      });
      return accepted(receipt.receiptId);
    },
  });
}

function createRecoveryService(deps: ProductionScheduleEffectDependencies) {
  const runs = Object.freeze({
    interruptedRuns: () => deps.queries.interruptedAttempts(),
    async interruptRun(input: { readonly sessionId: string; readonly runId: string }) {
      const row = await deps.queries.attemptByRunId(input.runId);
      if (
        row === undefined ||
        row.sessionId !== input.sessionId ||
        (row.state.status !== "starting" &&
          row.state.status !== "running" &&
          row.state.status !== "waiting")
      )
        return "unchanged" as const;
      const transitionId =
        row.state.status === "waiting"
          ? "AT-15"
          : row.state.status === "starting"
            ? "AT-06"
            : "AT-11";
      const result = await deps.recovery.interruptAttempt({
        transitionId,
        attempt: attemptRef(row),
        reason: "server restart",
        requestId: `recovery:${row.state.runId}`,
      });
      if (result === "conflict") {
        report(deps, "recovery_transition_rejected", row.attemptId);
        return "unchanged" as const;
      }
      return "recovered" as const;
    },
  });
  const messages = Object.freeze({
    async interruptedMessages() {
      const rows = await deps.queries.interruptedMessages();
      return rows.map(({ sessionId, messageId }) => ({ sessionId, messageId }));
    },
    async reconcileInterruptedMessage(input: {
      readonly sessionId: string;
      readonly messageId: string;
      readonly requestId?: string;
    }) {
      const row = await deps.queries.message(input.messageId);
      if (
        row === undefined ||
        row.sessionId !== input.sessionId ||
        row.state.status !== "streaming"
      ) {
        return "unchanged" as const;
      }
      const facts = messageRecoveryFacts(row);
      if (facts === undefined) {
        report(deps, "recovery_transition_rejected", input.messageId);
        return "unchanged" as const;
      }
      const result = await deps.recovery.failStreamingMessage({
        transitionId: "MS-07",
        ownerKey: row.ownerKey,
        sessionId: input.sessionId,
        messageId: input.messageId,
        surfaceId: facts.surfaceId,
        role: facts.role,
        model: facts.model,
        requestId: input.requestId ?? `recovery:message:${input.messageId}`,
      });
      if (result === "conflict") {
        report(deps, "recovery_transition_rejected", input.messageId);
        return "unchanged" as const;
      }
      return "recovered" as const;
    },
  });
  return Object.freeze({ runs, messages });
}

export function createProductionScheduleEffectServices(
  deps: ProductionScheduleEffectDependencies,
): ProductionScheduleEffectServices {
  nonEmpty(deps.workspaceId, "workspaceId");
  return Object.freeze({
    schedule: new ScheduleService({
      transitions: deps.schedule,
      queries: deps.schedule,
      principalId: "server",
      ownerKey: (scheduleId) => `schedule:${scheduleId}`,
      nowMs: deps.now,
    }),
    effects: createEffectService(deps),
    recovery: createRecoveryService(deps),
  });
}
