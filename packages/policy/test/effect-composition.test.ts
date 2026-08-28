import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { composeEffects } from "@openomni/policy";

interface DecisionOptions {
  readonly policyId: string;
  readonly verdict?: Policy.PolicyDecision["verdict"];
  readonly effects?: Policy.PolicyEffect[];
  readonly obligations?: Policy.PolicyObligation[];
  readonly priority?: number;
}

function decision(options: DecisionOptions): Policy.PolicyDecision {
  return {
    policyId: options.policyId,
    verdict: options.verdict ?? "allow",
    effects: options.effects ?? [],
    ...(options.obligations && { obligations: options.obligations }),
    reasonCodes: [`${options.policyId}.matched`],
    ...(options.priority !== undefined && { priority: options.priority }),
  };
}

const approval: Policy.PolicyObligation = {
  obligationId: "approval:workspace-write",
  type: "humanApproval",
  description: "Approve workspace write access.",
};
const d = (policyId: string, effects: Policy.PolicyEffect[], priority?: number) =>
  decision({ policyId, effects, priority });

function conflict(annotation: string) {
  return {
    verdict: "deny",
    mergedEffects: [{ type: "audit.annotate", annotation, severity: "error" }],
  };
}

describe("policy effect composition conformance", () => {
  const verdictCases: ReadonlyArray<{
    name: string;
    decisions: Policy.PolicyDecision[];
    verdict: Policy.EffectiveDecision["verdict"];
    obligations: Policy.PolicyObligation[];
  }> = [
    {
      name: "empty policy set allows without effects",
      decisions: [],
      verdict: "allow",
      obligations: [],
    },
    {
      name: "single allow remains allow",
      decisions: [
        d("policy.allow", [{ type: "prompt.append_context", context: "Use safe defaults." }]),
      ],
      verdict: "allow",
      obligations: [],
    },
    {
      name: "all allow remains allow",
      decisions: [d("policy.alpha", []), d("policy.beta", [])],
      verdict: "allow",
      obligations: [],
    },
    {
      name: "pending wins over allow",
      decisions: [
        d("policy.allow", []),
        decision({
          policyId: "policy.pending",
          verdict: "pending",
          effects: [{ type: "tool.require_approval", reason: "workspace write" }],
          obligations: [approval],
        }),
      ],
      verdict: "pending",
      obligations: [approval],
    },
    {
      name: "deny wins over pending and allow",
      decisions: [
        d("policy.allow", []),
        decision({ policyId: "policy.pending", verdict: "pending", obligations: [approval] }),
        decision({
          policyId: "policy.deny",
          verdict: "deny",
          effects: [{ type: "audit.annotate", annotation: "blocked", severity: "error" }],
        }),
      ],
      verdict: "deny",
      obligations: [],
    },
    {
      name: "all deny remains deny",
      decisions: [
        decision({
          policyId: "policy.deny-a",
          verdict: "deny",
          effects: [{ type: "audit.annotate", annotation: "a", severity: "error" }],
        }),
        decision({
          policyId: "policy.deny-b",
          verdict: "deny",
          effects: [{ type: "audit.annotate", annotation: "b", severity: "error" }],
        }),
      ],
      verdict: "deny",
      obligations: [],
    },
  ];

  for (const row of verdictCases) {
    it(row.name, () => {
      const result = composeEffects(row.decisions);
      expect(result.verdict).toBe(row.verdict);
      expect(result.obligations).toEqual(row.obligations);
    });
  }

  it("keeps only safe audit effects for deny decisions", () => {
    const result = composeEffects([
      decision({
        policyId: "policy.deny",
        verdict: "deny",
        effects: [
          { type: "prompt.append_context", context: "not safe after deny" },
          { type: "audit.annotate", annotation: "blocked dangerous operation", severity: "error" },
        ],
      }),
    ]);
    expect(result).toEqual({
      verdict: "deny",
      mergedEffects: [
        { type: "audit.annotate", annotation: "blocked dangerous operation", severity: "error" },
      ],
      obligations: [],
      contributingPolicies: ["policy.deny"],
    });
  });

  const conflictCases: ReadonlyArray<{
    name: string;
    decisions: Policy.PolicyDecision[];
    annotation: string;
  }> = [
    {
      name: "incompatible tool rewrites",
      decisions: [
        d("policy.command-a", [{ type: "tool.rewrite_input", input: { command: "pwd" } }]),
        d("policy.command-b", [{ type: "tool.rewrite_input", input: { command: "ls" } }]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: tool.rewrite_input.command rewritten by policy.command-a and policy.command-b",
    },
    {
      name: "alternate tool rewrite attribution",
      decisions: [
        d("policy.safe-command", [{ type: "tool.rewrite_input", input: { command: "pwd" } }]),
        d("policy.audit-command", [{ type: "tool.rewrite_input", input: { command: "ls" } }]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: tool.rewrite_input.command rewritten by policy.audit-command and policy.safe-command",
    },
    {
      name: "incompatible delegation maxDepth",
      decisions: [
        d("policy.delegate-a", [
          { type: "delegation.set_constraints", constraints: { maxDepth: 1 } },
        ]),
        d("policy.delegate-b", [
          { type: "delegation.set_constraints", constraints: { maxDepth: 2 } },
        ]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: delegation.set_constraints.maxDepth rewritten by policy.delegate-a and policy.delegate-b",
    },
    {
      name: "incompatible delegation maxTurns",
      decisions: [
        d("policy.strict-a", [
          { type: "delegation.set_constraints", constraints: { maxTurns: 1 } },
        ]),
        d("policy.strict-b", [
          { type: "delegation.set_constraints", constraints: { maxTurns: 2 } },
        ]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: delegation.set_constraints.maxTurns rewritten by policy.strict-a and policy.strict-b",
    },
    {
      name: "prompt replacement",
      decisions: [
        d("policy.prompt-a", [{ type: "prompt.replace", prompt: "Prompt A" }]),
        d("policy.prompt-b", [{ type: "prompt.replace", prompt: "Prompt B" }]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: prompt.replace.prompt rewritten by policy.prompt-a and policy.prompt-b",
    },
    {
      name: "writeback rewrites",
      decisions: [
        d("policy.rewrite-a", [{ type: "writeback.rewrite", output: "Output A" }]),
        d("policy.rewrite-b", [{ type: "writeback.rewrite", output: "Output B" }]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: writeback.rewrite.output rewritten by policy.rewrite-a and policy.rewrite-b",
    },
    {
      name: "continuation prompts",
      decisions: [
        d("policy.continue-a", [{ type: "run.continue_with_prompt", prompt: "ask A" }]),
        d("policy.continue-b", [{ type: "run.continue_with_prompt", prompt: "ask B" }]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: run.continue_with_prompt.prompt rewritten by policy.continue-a and policy.continue-b",
    },
    {
      name: "replacement messages",
      decisions: [
        d("policy.compact-a", [{ type: "run.replace_messages", messages: [{ id: "a" }] }]),
        d("policy.compact-b", [{ type: "run.replace_messages", messages: [{ id: "b" }] }]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: run.replace_messages.messages rewritten by policy.compact-a and policy.compact-b",
    },
    {
      name: "writeback rewrite and suppression",
      decisions: [
        d("policy.redact", [{ type: "writeback.rewrite", output: "Redacted output." }]),
        d("policy.suppress", [
          { type: "writeback.suppress", reason: "contains sensitive content" },
        ]),
      ],
      annotation:
        "policy.effect_conflict.fail_closed: writeback.suppress conflicts with writeback.rewrite from policy.redact and policy.suppress",
    },
  ];

  for (const row of conflictCases) {
    it(`fails closed for ${row.name}`, () => {
      expect(composeEffects(row.decisions)).toMatchObject(conflict(row.annotation));
    });
  }

  const priorityCases: ReadonlyArray<{
    name: string;
    decisions: Policy.PolicyDecision[];
    effect: Policy.PolicyEffect;
  }> = [
    {
      name: "tool input rewrites",
      decisions: [
        d(
          "policy.low",
          [{ type: "tool.rewrite_input", input: { command: "pwd", cwd: "/tmp" } }],
          10,
        ),
        d("policy.high", [{ type: "tool.rewrite_input", input: { command: "ls" } }], 20),
      ],
      effect: { type: "tool.rewrite_input", input: { command: "ls", cwd: "/tmp" } },
    },
    {
      name: "delegation constraints",
      decisions: [
        d(
          "policy.low",
          [
            {
              type: "delegation.set_constraints",
              constraints: { maxTurns: 1, timeout: { softMs: 100 } },
            },
          ],
          10,
        ),
        d(
          "policy.high",
          [
            {
              type: "delegation.set_constraints",
              constraints: { maxTurns: 2, timeout: { hardMs: 200 } },
            },
          ],
          20,
        ),
      ],
      effect: {
        type: "delegation.set_constraints",
        constraints: { maxTurns: 2, timeout: { softMs: 100, hardMs: 200 } },
      },
    },
    {
      name: "continuation prompts",
      decisions: [
        d("policy.low", [{ type: "run.continue_with_prompt", prompt: "ask low" }], 10),
        d("policy.high", [{ type: "run.continue_with_prompt", prompt: "ask high" }], 20),
      ],
      effect: { type: "run.continue_with_prompt", prompt: "ask high" },
    },
    {
      name: "replacement messages",
      decisions: [
        d("policy.low", [{ type: "run.replace_messages", messages: [{ id: "low" }] }], 10),
        d("policy.high", [{ type: "run.replace_messages", messages: [{ id: "high" }] }], 20),
      ],
      effect: { type: "run.replace_messages", messages: [{ id: "high" }] },
    },
    {
      name: "tool output rewrites",
      decisions: [
        d("policy.low", [{ type: "tool.rewrite_output", output: "low" }], 10),
        d("policy.high", [{ type: "tool.rewrite_output", output: "high" }], 20),
      ],
      effect: { type: "tool.rewrite_output", output: "high" },
    },
    {
      name: "writeback rewrite over suppression",
      decisions: [
        d(
          "policy.suppress",
          [{ type: "writeback.suppress", reason: "contains sensitive content" }],
          10,
        ),
        d("policy.rewrite", [{ type: "writeback.rewrite", output: "safe output" }], 20),
      ],
      effect: { type: "writeback.rewrite", output: "safe output" },
    },
  ];

  for (const row of priorityCases) {
    it(`lets higher-priority ${row.name} win`, () => {
      const result = composeEffects(row.decisions);
      expect(result.verdict).toBe("allow");
      expect(result.mergedEffects).toContainEqual(row.effect);
    });
  }

  it("orders effects by priority and id and deduplicates exact effects", () => {
    const duplicate: Policy.PolicyEffect = { type: "prompt.append_context", context: "first" };
    const result = composeEffects([
      d("policy.beta", [{ type: "prompt.append_context", context: "second" }], 20),
      d("policy.gamma", [{ type: "prompt.append_context", context: "third" }], 10),
      d("policy.alpha", [duplicate, duplicate], 20),
    ]);
    expect(result.verdict).toBe("allow");
    expect(result.mergedEffects).toEqual([
      { type: "prompt.append_context", context: "third" },
      duplicate,
      { type: "prompt.append_context", context: "second" },
    ]);
    expect(result.contributingPolicies).toEqual(["policy.gamma", "policy.alpha", "policy.beta"]);
  });

  it("deduplicates structurally identical message effects", () => {
    const duplicate: Policy.PolicyEffect = {
      type: "prompt.inject_message",
      role: "user",
      message: "Be careful.",
    };
    expect(
      composeEffects([
        d("policy.alpha", [duplicate, duplicate]),
        d("policy.beta", [{ message: "Be careful.", role: "user", type: "prompt.inject_message" }]),
      ]).mergedEffects,
    ).toEqual([duplicate]);
  });

  it("appends additive effects and unions filters", () => {
    const result = composeEffects([
      d("policy.alpha", [
        { type: "prompt.append_context", context: "alpha" },
        { type: "audit.annotate", annotation: "alpha-audit", severity: "info" },
        { type: "tool.filter", toolPattern: "shell.*" },
      ]),
      d("policy.beta", [
        { type: "prompt.append_context", context: "beta" },
        { type: "tool.filter", toolPattern: "network.*" },
      ]),
    ]);
    expect(result.mergedEffects).toEqual([
      { type: "prompt.append_context", context: "alpha" },
      { type: "audit.annotate", annotation: "alpha-audit", severity: "info" },
      { type: "tool.filter", toolPattern: "shell.*" },
      { type: "prompt.append_context", context: "beta" },
      { type: "tool.filter", toolPattern: "network.*" },
    ]);
  });

  it("deep-merges compatible records", () => {
    const result = composeEffects([
      d("policy.alpha", [{ type: "tool.rewrite_input", input: { env: { SAFE: "1" } } }]),
      d("policy.beta", [{ type: "tool.rewrite_input", input: { cwd: "/tmp" } }]),
    ]);
    expect(result.verdict).toBe("allow");
    expect(result.mergedEffects).toEqual([
      { type: "tool.rewrite_input", input: { env: { SAFE: "1" }, cwd: "/tmp" } },
    ]);
  });

  it("composes retry limits and workspace locks", () => {
    const result = composeEffects([
      d("policy.generous", [
        { type: "run.retry_after", delayMs: 1_000, maxRetries: 3 },
        { type: "runtime.workspace_lock", required: false },
      ]),
      d("policy.strict", [
        { type: "run.retry_after", delayMs: 5_000, maxRetries: 1 },
        { type: "runtime.workspace_lock", required: true },
      ]),
    ]);
    expect(result.verdict).toBe("allow");
    expect(result.mergedEffects).toEqual(
      expect.arrayContaining([
        { type: "run.retry_after", delayMs: 5_000, maxRetries: 1 },
        { type: "runtime.workspace_lock", required: true },
      ]),
    );
  });

  it("concatenates approval reasons", () => {
    const result = composeEffects([
      d("policy.alpha", [
        { type: "tool.require_approval", reason: "workspace write" },
        { type: "delegation.require_approval", reason: "external worker" },
      ]),
      d("policy.beta", [
        { type: "tool.require_approval", reason: "network access" },
        { type: "delegation.require_approval", reason: "sensitive prompt" },
      ]),
    ]);
    expect(result.mergedEffects).toEqual(
      expect.arrayContaining([
        { type: "tool.require_approval", reason: "workspace write; network access" },
        { type: "delegation.require_approval", reason: "external worker; sensitive prompt" },
      ]),
    );
  });

  it("is pure for identical inputs", () => {
    const decisions = [
      d("policy.alpha", [{ type: "prompt.append_context", context: "alpha" }], 10),
      d("policy.beta", [{ type: "audit.annotate", annotation: "beta", severity: "info" }]),
    ];
    expect(composeEffects(decisions)).toEqual(composeEffects(decisions));
    expect(decisions).toEqual([
      d("policy.alpha", [{ type: "prompt.append_context", context: "alpha" }], 10),
      d("policy.beta", [{ type: "audit.annotate", annotation: "beta", severity: "info" }]),
    ]);
  });
});
