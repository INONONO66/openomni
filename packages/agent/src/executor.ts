import type {
  BusEvent,
  LedgerAction,
  LedgerSession,
  ObservationSink,
  PlainValue,
} from "@openomni/protocol";
import { L0Observation, canonicalDigest } from "@openomni/protocol";
import type {
  CompiledPolicySnapshot,
  PolicyEvaluation,
  PolicyEvaluationInput,
} from "@openomni/policy";

const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool"]);

export interface ExecutionLedger {
  commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt>;
}

export interface ExecutionIdentity {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly parentActionId: string | null;
}

export interface ExecutionRequest {
  readonly kind: string;
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  readonly revert?: () => void | Promise<void>;
}

export type ExecutionResult<T> =
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: T }
  | {
      readonly terminal: "blocked_post";
      readonly disposition: "reverted" | "irreversible";
      readonly reason: string;
    };

export interface Executor {
  run<T extends PlainValue>(
    request: ExecutionRequest,
    body: () => Promise<T>,
  ): Promise<ExecutionResult<T>>;
}

export interface ExecutorOptions {
  readonly policy: CompiledPolicySnapshot;
  readonly ledger: ExecutionLedger;
  readonly observations: ObservationSink | BusEvent.Sink;
  readonly identity: ExecutionIdentity;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly registeredKinds?: readonly string[];
}

export function createExecutor(options: ExecutorOptions): Executor {
  const kinds = new Set([...CORE_KINDS, ...(options.registeredKinds ?? [])]);

  async function commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt> {
    const receipt = await options.ledger.commit(action);
    options.observations.publish(L0Observation.ActionCommittedEvent, {
      id: receipt.action.id,
      sessionId: receipt.action.sessionId,
      revision: receipt.revision,
      kind: receipt.action.kind,
    });
    return receipt;
  }

  async function decide(
    request: ExecutionRequest,
    phase: "pre" | "post",
    value: PlainValue,
  ): Promise<PolicyEvaluation> {
    const input: PolicyEvaluationInput = {
      kind: request.kind,
      phase,
      op: request.op,
      role: options.identity.role,
      sessionId: options.identity.sessionId,
      value,
    };
    const decision = options.policy.evaluate(input);
    await commit({
      id: options.entropy(),
      parentId: options.identity.parentActionId,
      sessionId: options.identity.sessionId,
      kind: "policy.decision",
      intent: {
        encodingVersion: 1,
        value: {
          hook: `${request.kind}.${phase}`,
          generation: decision.generation,
          matchedRuleIds: [...decision.matchedRuleIds],
          verdict: decision.verdict,
          inputHash: decision.inputHash,
        },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "result",
          reason: decision.reason ?? null,
        },
      },
      ts: options.clock(),
      irreversible: true,
    });
    return decision;
  }

  async function run<T extends PlainValue>(
    request: ExecutionRequest,
    body: () => Promise<T>,
  ): Promise<ExecutionResult<T>> {
    if (!kinds.has(request.kind)) throw new Error(`unregistered execution kind: ${request.kind}`);

    const pre = await decide(request, "pre", request.intent);
    if (blocks(pre)) {
      return { terminal: "blocked_pre", reason: pre.reason ?? "denied" };
    }

    const intentId = options.entropy();
    await commit({
      id: intentId,
      parentId: options.identity.parentActionId,
      sessionId: options.identity.sessionId,
      kind: request.kind as LedgerAction.Kind,
      intent: {
        encodingVersion: 1,
        value: { phase: "intent", op: request.op, value: request.intent },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      ts: options.clock(),
      irreversible: true,
    });

    const value = await body();
    const resultValue = clonePlainValue(value);
    const post = await decide(request, "post", {
      intent: request.intent,
      effect: request.effect,
      result: resultValue,
    });

    if (blocks(post)) {
      const disposition = request.revert === undefined ? "irreversible" : "reverted";
      if (request.revert !== undefined) await request.revert();
      await appendResult(request, intentId, {
        phase: "result",
        terminal: "blocked_post",
        disposition,
        reason: post.reason ?? "denied",
        effect: request.effect,
        resultHash: canonicalDigest(resultValue),
      });
      return {
        terminal: "blocked_post",
        disposition,
        reason: post.reason ?? "denied",
      };
    }

    await appendResult(request, intentId, {
      phase: "result",
      terminal: "executed",
      effect: request.effect,
      resultHash: canonicalDigest(resultValue),
    });
    return { terminal: "executed", value };
  }

  async function appendResult(
    request: ExecutionRequest,
    intentId: string,
    effect: PlainValue,
  ): Promise<void> {
    await commit({
      id: options.entropy(),
      parentId: intentId,
      sessionId: options.identity.sessionId,
      kind: request.kind as LedgerAction.Kind,
      intent: {
        encodingVersion: 1,
        value: { phase: "result", op: request.op },
      },
      effect: { encodingVersion: 1, value: effect },
      ts: options.clock(),
      irreversible: true,
    });
  }

  return { run };
}

function blocks(decision: PolicyEvaluation): boolean {
  return decision.verdict === "deny" || decision.verdict === "require_approval";
}

function clonePlainValue(value: PlainValue): PlainValue {
  return JSON.parse(JSON.stringify(value)) as PlainValue;
}
