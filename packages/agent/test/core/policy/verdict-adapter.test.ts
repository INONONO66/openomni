import { describe, expect, it } from "bun:test";
import { verdictToDecision } from "../../../src/core/policy/verdict-adapter";

describe("verdictToDecision", () => {
  it("maps legacy verdicts to policy decisions", () => {
    expect(
      verdictToDecision({ action: "continue" }, { timing: "run.start", policyId: "policy.safe" }),
    ).toEqual({
      policyId: "policy.safe",
      verdict: "allow",
      effects: [],
      reasonCodes: [],
    });

    expect(
      verdictToDecision(
        { action: "abort", reason: "operator stopped" },
        { timing: "run.start", policyId: "policy.abort" },
      ),
    ).toEqual({
      policyId: "policy.abort",
      verdict: "deny",
      effects: [{ type: "run.abort", reason: "operator stopped" }],
      reasonCodes: ["operator stopped"],
    });

    expect(
      verdictToDecision(
        { action: "deny", reason: "not authorized" },
        { timing: "invoke.prepare", policyId: "policy.authz", toolName: "shell" },
      ),
    ).toEqual({
      policyId: "policy.authz",
      verdict: "deny",
      effects: [{ type: "audit.annotate", annotation: "not authorized", severity: "error" }],
      reasonCodes: ["not authorized"],
    });

    expect(
      verdictToDecision(
        { action: "inject", message: "Use safer tools." },
        { timing: "model.request", policyId: "policy.inject" },
      ),
    ).toEqual({
      policyId: "policy.inject",
      verdict: "allow",
      effects: [{ type: "prompt.inject_message", message: "Use safer tools." }],
      reasonCodes: [],
    });
  });

  it("fails closed for unsupported pre-boundary verdicts and emits diagnostics post-boundary", () => {
    expect(
      verdictToDecision(
        { action: "skip", reason: "not a tool point" },
        { timing: "run.start", policyId: "policy.skip" },
      ),
    ).toEqual({
      policyId: "policy.skip",
      verdict: "deny",
      effects: [
        {
          type: "audit.annotate",
          annotation: "unsupported verdict skip at run.start: not a tool point",
          severity: "error",
        },
      ],
      reasonCodes: ["not a tool point"],
    });

    expect(
      verdictToDecision(
        { action: "skip", reason: "too late" },
        { timing: "invoke.result", policyId: "policy.skip" },
      ),
    ).toEqual({
      policyId: "policy.skip",
      verdict: "allow",
      effects: [
        {
          type: "audit.annotate",
          annotation: "unsupported verdict skip at invoke.result: too late",
          severity: "warning",
        },
      ],
      reasonCodes: ["too late"],
    });

    expect(
      verdictToDecision(
        { action: "retry", reason: "transient" },
        { timing: "run.finish", policyId: "policy.retry" },
      ),
    ).toEqual({
      policyId: "policy.retry",
      verdict: "allow",
      effects: [
        {
          type: "audit.annotate",
          annotation: "unsupported verdict retry at run.finish: transient",
          severity: "warning",
        },
      ],
      reasonCodes: ["transient"],
    });
  });

  it("adapts tool skip, retry, and transform at supported points", () => {
    expect(
      verdictToDecision(
        { action: "skip", reason: "tool disabled" },
        { timing: "invoke.prepare", policyId: "policy.skip", toolName: "shell" },
      ),
    ).toEqual({
      policyId: "policy.skip",
      verdict: "allow",
      effects: [{ type: "tool.skip_invocation" }],
      reasonCodes: ["tool disabled"],
    });

    expect(
      verdictToDecision(
        { action: "retry", reason: "backoff" },
        { timing: "error", policyId: "policy.retry" },
      ),
    ).toEqual({
      policyId: "policy.retry",
      verdict: "pending",
      effects: [{ type: "run.retry_after", delayMs: 0, maxRetries: 3 }],
      reasonCodes: ["backoff"],
    });

    expect(
      verdictToDecision(
        { action: "transform", input: { prompt: "Safer prompt." } },
        { timing: "context.prepare", policyId: "policy.prompt" },
      ),
    ).toEqual({
      policyId: "policy.prompt",
      verdict: "allow",
      effects: [{ type: "prompt.replace", prompt: "Safer prompt." }],
      reasonCodes: [],
    });

    expect(
      verdictToDecision(
        { action: "transform", input: { command: "pwd" } },
        { timing: "invoke.prepare", policyId: "policy.tool" },
      ),
    ).toEqual({
      policyId: "policy.tool",
      verdict: "allow",
      effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
      reasonCodes: [],
    });

    expect(
      verdictToDecision(
        { action: "transform", input: { output: "redacted" } },
        { timing: "model.response", policyId: "policy.unsupported" },
      ),
    ).toEqual({
      policyId: "policy.unsupported",
      verdict: "allow",
      effects: [
        {
          type: "audit.annotate",
          annotation: "transform at unsupported point",
          severity: "warning",
        },
      ],
      reasonCodes: [],
    });
  });
});
