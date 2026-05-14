import type { Policy } from "@openomni/protocol";

interface VerdictAdapterContext {
  readonly timing: Policy.Timing;
  readonly policyId: string;
  readonly toolName?: string;
}

const preBoundaryTimings = new Set<Policy.Timing>([
  "inbound.receive",
  "run.start",
  "turn.start",
  "context.prepare",
  "resources.prepare",
  "model.request",
  "invoke.prepare",
  "completion.prepare",
  "writeback.commit",
]);

const postBoundaryTimings = new Set<Policy.Timing>([
  "model.response",
  "invoke.result",
  "turn.finish",
  "run.finish",
]);

const retryTimings = new Set<Policy.Timing>(["turn.start", "error"]);

function reasonCodes(verdict: Policy.Verdict): string[] {
  return verdict.reason === undefined ? [] : [verdict.reason];
}

function policyId(verdict: Policy.Verdict, context: VerdictAdapterContext): string {
  return verdict.policyId ?? context.policyId;
}

function decision(
  verdict: Policy.Verdict,
  context: VerdictAdapterContext,
  adaptedVerdict: Policy.PolicyDecision["verdict"],
  effects: Policy.PolicyEffect[],
): Policy.PolicyDecision {
  return {
    policyId: policyId(verdict, context),
    verdict: adaptedVerdict,
    effects,
    reasonCodes: reasonCodes(verdict),
  };
}

function unsupported(
  verdict: Policy.Verdict,
  context: VerdictAdapterContext,
  annotation: string,
): Policy.PolicyDecision {
  if (postBoundaryTimings.has(context.timing)) {
    return decision(verdict, context, "allow", [
      { type: "audit.annotate", annotation, severity: "warning" },
    ]);
  }

  if (preBoundaryTimings.has(context.timing) || context.timing === "error") {
    return decision(verdict, context, "deny", [
      { type: "audit.annotate", annotation, severity: "error" },
    ]);
  }

  return decision(verdict, context, "deny", [
    { type: "audit.annotate", annotation, severity: "error" },
  ]);
}

function unsupportedVerdict(
  verdict: Policy.Verdict,
  context: VerdictAdapterContext,
): Policy.PolicyDecision {
  const reason = verdict.reason === undefined ? "" : `: ${verdict.reason}`;
  return unsupported(
    verdict,
    context,
    `unsupported verdict ${verdict.action} at ${context.timing}${reason}`,
  );
}

function promptFromInput(input: Record<string, unknown>): string {
  const prompt = input.prompt ?? input.systemPrompt ?? input.message;
  return typeof prompt === "string" ? prompt : JSON.stringify(input);
}

export function verdictToDecision(
  verdict: Policy.Verdict,
  context: VerdictAdapterContext,
): Policy.PolicyDecision {
  switch (verdict.action) {
    case "continue":
      return decision(verdict, context, "allow", []);

    case "abort":
      return decision(verdict, context, "deny", [{ type: "run.abort", reason: verdict.reason }]);

    case "deny":
      return decision(verdict, context, "deny", [
        {
          type: "audit.annotate",
          annotation: verdict.reason ?? "denied",
          severity: "error",
        },
      ]);

    case "skip":
      if (context.timing !== "invoke.prepare") return unsupportedVerdict(verdict, context);
      return decision(verdict, context, "allow", [{ type: "tool.skip_invocation" }]);

    case "retry":
      if (!retryTimings.has(context.timing)) return unsupportedVerdict(verdict, context);
      return decision(verdict, context, "pending", [
        { type: "run.retry_after", delayMs: 0, maxRetries: 3 },
      ]);

    case "inject":
      return decision(verdict, context, "allow", [
        { type: "prompt.inject_message", message: verdict.message },
      ]);

    case "transform":
      if (context.timing === "context.prepare") {
        return decision(verdict, context, "allow", [
          { type: "prompt.replace", prompt: promptFromInput(verdict.input) },
        ]);
      }

      if (context.timing === "invoke.prepare") {
        return decision(verdict, context, "allow", [
          { type: "tool.rewrite_input", input: verdict.input },
        ]);
      }

      return unsupported(verdict, context, "transform at unsupported point");
  }
}
