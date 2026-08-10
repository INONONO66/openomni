import { composeEffects } from "@openomni/policy";
import { Policy, PolicyDecision, type Ingress, type TraceContext } from "@openomni/protocol";

/**
 * Kernel-local ingress policy gates (#530).
 *
 * The ingress boundary used to run its policies through the generic policy
 * engine's legacy `dispatch(timing)` path. That path is retired; the
 * canonical point grid could not honestly absorb these gates either — the
 * `session.inbound.pre` contract requires an `actorId`, but anonymous
 * senders are legal at this boundary by design (channel grants materialize
 * default-tier strangers), and no session exists yet at routed pre-run time.
 * So the kernel owns its own two admission gates with the same composition
 * semantics: ascending priority, deny-wins short circuit, fail-closed error
 * containment, per-decision observer fan-out.
 */
export namespace IngressPolicyGate {
  const COMPOSED_POLICY_ID = "ingress.policy.composed";

  export interface InboundContext {
    readonly gate: "inbound";
    readonly actor?: Ingress.Actor;
    readonly surface: string;
    readonly mode: string;
    readonly target: string;
    readonly inboundTreatment?: string;
    readonly channelGrantId?: string;
    readonly channelGrantKind?: string;
    readonly labels: readonly Policy.LabelEntry[];
    readonly traceContext?: TraceContext.Type;
  }

  export interface WritebackContext {
    readonly gate: "writeback";
    readonly sessionId: string;
    readonly surface: string;
    readonly mode: string;
    readonly target: string;
    readonly output: string;
    readonly labels: readonly Policy.LabelEntry[];
    readonly traceContext?: TraceContext.Type;
  }

  /**
   * The routed pre-run gate (ingress-authority) carries no dispatch payload:
   * its checks close over pipeline state and validate the raw event before a
   * session or run exists.
   */
  export interface PreRunContext {
    readonly gate: "pre-run";
    readonly traceContext?: TraceContext.Type;
  }

  export interface IngressPolicy {
    readonly name: string;
    /** Which ingress boundary this policy runs at. */
    readonly gate: "inbound" | "writeback" | "pre-run";
    /** Ascending execution order; equal priorities keep registration order. */
    readonly priority: number;
    /** Defaults to fail-closed: a thrown policy denies the gate. */
    readonly failPolicy?: Policy.FailPolicy;
    readonly fn: (
      ctx: Readonly<InboundContext | WritebackContext | PreRunContext>,
    ) => Policy.PolicyDecision | Promise<Policy.PolicyDecision>;
  }

  function select(
    policies: readonly IngressPolicy[] | undefined,
    gate: IngressPolicy["gate"],
  ): IngressPolicy[] {
    return (policies ?? [])
      .map((policy, index) => ({ policy, index }))
      .filter(({ policy }) => policy.gate === gate)
      .sort(
        (left, right) => left.policy.priority - right.policy.priority || left.index - right.index,
      )
      .map(({ policy }) => policy);
  }

  function failClosedDecision(policy: IngressPolicy, reason: string): Policy.PolicyDecision {
    return PolicyDecision.deny({
      policyId: policy.name,
      reasonCodes: [reason],
      effects: [
        { type: "run.abort", reason },
        { type: "audit.annotate", annotation: `${policy.name}: ${reason}`, severity: "error" },
      ],
    });
  }

  type OnDecision = (decision: Policy.PolicyDecision) => void | Promise<void>;

  function notify(onDecision: OnDecision | undefined, decision: Policy.PolicyDecision): void {
    if (!onDecision) return;
    try {
      // Observers must not block or fail the gate.
      void Promise.resolve(onDecision(decision)).catch(() => undefined);
    } catch {
      // Synchronous observer errors are isolated the same way.
    }
  }

  function compose(decisions: readonly Policy.PolicyDecision[]): Policy.PolicyDecision {
    if (decisions.length === 0) {
      return PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID });
    }
    const effective = composeEffects([...decisions]);
    const reasonSources =
      effective.verdict === "allow"
        ? decisions
        : decisions.filter((decision) => decision.verdict === effective.verdict);
    return {
      policyId: COMPOSED_POLICY_ID,
      verdict: effective.verdict,
      effects: effective.mergedEffects,
      ...(effective.obligations.length > 0 && { obligations: effective.obligations }),
      reasonCodes: [...new Set(reasonSources.flatMap((decision) => decision.reasonCodes))],
      durationMs: decisions.reduce((total, decision) => total + (decision.durationMs ?? 0), 0),
    };
  }

  /** Evaluate one gate and return the composed decision. */
  export async function evaluate(
    policies: readonly IngressPolicy[] | undefined,
    ctx: InboundContext | WritebackContext | PreRunContext,
    onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>,
  ): Promise<Policy.PolicyDecision> {
    const decisions: Policy.PolicyDecision[] = [];
    for (const policy of select(policies, ctx.gate)) {
      const startTime = Date.now();
      let decision: Policy.PolicyDecision;
      try {
        const returned = await policy.fn(ctx);
        const parsed = Policy.PolicyDecision.safeParse(returned);
        decision = parsed.success
          ? parsed.data
          : failClosedDecision(policy, "policy.invalid_decision");
      } catch {
        if ((policy.failPolicy ?? "fail-closed") === "fail-open") continue;
        decision = failClosedDecision(policy, "middleware-error");
      }
      const normalized = {
        ...decision,
        durationMs: Date.now() - startTime,
        priority: policy.priority,
      };
      decisions.push(normalized);
      notify(onDecision, normalized);
      if (normalized.verdict === "deny") break;
    }
    return compose(decisions);
  }
}
