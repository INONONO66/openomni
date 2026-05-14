import { z } from "zod";

export const policyKernelVersion = 1;

export namespace Policy {
  const MAX_REGEX_PATTERN_LENGTH = 200;
  const MAX_INPUT_LENGTH = 10_000;
  const POLICY_ID = "guardrail.permission";

  // Label source enumeration: where a label originates from
  // Labels use source.category naming convention to prevent namespace collisions
  // Examples: tool.filesystem, actor.owner, surface.github, risk.tier-2, capability.write
  export const Label = {
    Source: z.enum(["system", "tool_metadata", "agent_profile", "policy_rule", "operator"]),
  } as const;

  export type Label = {
    Source: z.infer<typeof Label.Source>;
  };

  // Label entry: a labeled value with its source for audit and policy evaluation
  export const LabelEntry = z.object({
    value: z.string(),
    source: Label.Source,
  });
  export type LabelEntry = z.infer<typeof LabelEntry>;

  export const PermissionDecision = z.enum(["allow", "deny", "require_approval"]);
  export type PermissionDecision = z.infer<typeof PermissionDecision>;

  export const InputRule = z.object({
    toolPattern: z.string(),
    field: z.string(),
    pattern: z.string().refine(
      (p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      },
      { message: "pattern must be a valid regular expression" },
    ),
    action: PermissionDecision,
    reason: z.string().optional(),
    priority: z.number().default(0),
  });
  export type InputRule = z.infer<typeof InputRule>;

  export const Permission = z.object({
    action: z.string(),
    allowlist: z.string().array().optional(),
    denylist: z.string().array().optional(),
    requireApproval: z.string().array().optional(),
    allowLabels: z.string().array().optional(),
    denyLabels: z.string().array().optional(),
    requireApprovalLabels: z.string().array().optional(),
    inputRules: InputRule.array().optional(),
  });
  export type Permission = z.infer<typeof Permission>;

  export const EvaluationRequest = z.object({
    action: z.string(),
    resource: z.string(),
    resourceLabels: z.array(z.string()).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    actor: z.record(z.string(), z.unknown()).optional(),
    resourceMeta: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type EvaluationRequest = z.infer<typeof EvaluationRequest>;

  export const EvaluationResult = z.object({
    action: z.enum(["continue", "abort"]),
    decision: PermissionDecision.optional(),
    reason: z.string(),
    policyId: z.string(),
    matchedPattern: z.string().optional(),
  });
  export type EvaluationResult = z.infer<typeof EvaluationResult>;

  function matchesPattern(resource: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) return resource.startsWith(`${pattern.slice(0, -2)}.`);
    return resource === pattern;
  }

  function findMatchingLabel(
    labels: readonly string[] | undefined,
    patterns: readonly string[] | undefined,
  ): string | undefined {
    if (!patterns || patterns.length === 0) return undefined;
    for (const pattern of patterns) {
      if (labels?.some((label) => matchesPattern(label, pattern))) return pattern;
    }
    return undefined;
  }

  function matchesInputField(
    input: Record<string, unknown> | undefined,
    field: string,
    pattern: string,
  ): boolean {
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;

    const raw = String(input?.[field] ?? "");
    const value = raw.length > MAX_INPUT_LENGTH ? raw.slice(0, MAX_INPUT_LENGTH) : raw;

    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  }

  function verdict(
    decision: PermissionDecision,
    reason: string,
    matchedPattern?: string,
  ): EvaluationResult {
    const action: EvaluationResult["action"] = decision === "allow" ? "continue" : "abort";
    return matchedPattern === undefined
      ? { action, decision, reason, policyId: POLICY_ID }
      : { action, decision, reason, policyId: POLICY_ID, matchedPattern };
  }

  export function evaluate(
    permission: Permission | undefined,
    request: EvaluationRequest,
  ): EvaluationResult {
    if (!permission) return verdict("allow", "default_allow");
    if (permission.action !== request.action) return verdict("deny", "action_mismatch");

    const inputRules = [...(permission.inputRules ?? [])].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );

    for (const rule of inputRules) {
      if (
        matchesPattern(request.resource, rule.toolPattern) &&
        matchesInputField(request.input, rule.field, rule.pattern)
      ) {
        return verdict(rule.action, rule.reason ?? `input_rule_${rule.action}`, rule.toolPattern);
      }
    }

    const deniedBy = permission.denylist?.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );
    if (deniedBy) return verdict("deny", "denylist", deniedBy);

    const deniedByLabel = findMatchingLabel(request.resourceLabels, permission.denyLabels);
    if (deniedByLabel) return verdict("deny", "deny_label", deniedByLabel);

    const requiresApprovalBy = permission.requireApproval?.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );
    if (requiresApprovalBy) {
      return verdict("require_approval", "require_approval", requiresApprovalBy);
    }

    const requiresApprovalByLabel = findMatchingLabel(
      request.resourceLabels,
      permission.requireApprovalLabels,
    );
    if (requiresApprovalByLabel) {
      return verdict("require_approval", "require_approval_label", requiresApprovalByLabel);
    }

    if (permission.allowlist !== undefined) {
      const allowedBy = permission.allowlist.find((pattern) =>
        matchesPattern(request.resource, pattern),
      );

      if (allowedBy) return verdict("allow", "allowlist", allowedBy);

      return verdict(
        "deny",
        permission.allowlist.length === 0 ? "allowlist_empty" : "allowlist_miss",
      );
    }

    if (permission.allowLabels !== undefined) {
      const allowedByLabel = findMatchingLabel(request.resourceLabels, permission.allowLabels);
      if (allowedByLabel) return verdict("allow", "allow_label", allowedByLabel);
      return verdict(
        "deny",
        permission.allowLabels.length === 0 ? "allow_labels_empty" : "allow_labels_miss",
      );
    }

    return verdict("allow", "default_allow");
  }

  export const Verdict = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("continue"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("skip"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("abort"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("retry"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("transform"),
      input: z.record(z.string(), z.unknown()),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("inject"),
      message: z.string(),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("deny"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
  ]);
  export type Verdict = z.infer<typeof Verdict>;

  export const Timing = {
    INBOUND_RECEIVE: "inbound.receive",
    RUN_START: "run.start",
    TURN_START: "turn.start",
    CONTEXT_PREPARE: "context.prepare",
    RESOURCES_PREPARE: "resources.prepare",
    MODEL_REQUEST: "model.request",
    MODEL_RESPONSE: "model.response",
    INVOKE_PREPARE: "invoke.prepare",
    INVOKE_RESULT: "invoke.result",
    TURN_FINISH: "turn.finish",
    COMPLETION_PREPARE: "completion.prepare",
    WRITEBACK_COMMIT: "writeback.commit",
    RUN_FINISH: "run.finish",
    ERROR: "error",
  } as const;

  export type Timing = (typeof Timing)[keyof typeof Timing];

  export const Scope = z.object({
    agentType: z.array(z.string()).optional(),
  });
  export type Scope = z.infer<typeof Scope>;

  export const FailPolicy = z.enum(["fail-open", "fail-closed"]);
  export type FailPolicy = z.infer<typeof FailPolicy>;

  export const Definition = z.object({
    name: z.string().min(1),
    timing: z.union([
      z.enum(Object.values(Timing) as [string, ...string[]]),
      z.array(z.enum(Object.values(Timing) as [string, ...string[]])),
    ]),
    priority: z.number().int().min(0),
    scope: Scope.optional(),
    failPolicy: FailPolicy.optional(),
  });
  export type Definition = z.infer<typeof Definition>;

  export const Decision = z.object({
    timing: z.string(),
    label: z.string(),
    policyId: z.string(),
    verdict: Verdict,
    reason: z.string().optional(),
    durationMs: z.number().optional(),
  });
  export type Decision = z.infer<typeof Decision>;

  export const PolicyEffectType = z.enum([
    "prompt.append_context",
    "prompt.inject_message",
    "prompt.replace",
    "tool.filter",
    "tool.rewrite_input",
    "tool.skip_invocation",
    "tool.require_approval",
    "run.abort",
    "run.continue_with_prompt",
    "run.retry_after",
    "delegation.set_constraints",
    "delegation.require_approval",
    "audit.annotate",
    "writeback.rewrite",
    "writeback.suppress",
    "runtime.set_timeout",
    "runtime.workspace_lock",
  ]);
  export type PolicyEffectType = z.infer<typeof PolicyEffectType>;

  export const PolicyEffect = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("prompt.append_context"),
      context: z.string(),
    }),
    z.object({
      type: z.literal("prompt.inject_message"),
      message: z.string(),
      role: z.enum(["user", "assistant"]).optional(),
    }),
    z.object({
      type: z.literal("prompt.replace"),
      prompt: z.string(),
    }),
    z.object({
      type: z.literal("tool.filter"),
      toolPattern: z.string(),
    }),
    z.object({
      type: z.literal("tool.rewrite_input"),
      input: z.record(z.string(), z.unknown()),
    }),
    z.object({
      type: z.literal("tool.skip_invocation"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("tool.require_approval"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("run.abort"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("run.continue_with_prompt"),
      prompt: z.string(),
    }),
    z.object({
      type: z.literal("run.retry_after"),
      delayMs: z.number().int().min(0),
      maxRetries: z.number().int().min(1).optional(),
    }),
    z.object({
      type: z.literal("delegation.set_constraints"),
      constraints: z.record(z.string(), z.unknown()),
    }),
    z.object({
      type: z.literal("delegation.require_approval"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("audit.annotate"),
      annotation: z.string(),
      severity: z.enum(["info", "warning", "error"]).optional(),
    }),
    z.object({
      type: z.literal("writeback.rewrite"),
      output: z.string(),
    }),
    z.object({
      type: z.literal("writeback.suppress"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("runtime.set_timeout"),
      timeoutMs: z.number().int().min(0),
    }),
    z.object({
      type: z.literal("runtime.workspace_lock"),
      required: z.boolean(),
    }),
  ]);
  export type PolicyEffect = z.infer<typeof PolicyEffect>;

  export const PolicyObligation = z.object({
    obligationId: z.string(),
    type: z.enum(["humanApproval", "evidenceRequired", "credentialConfirm"]),
    description: z.string(),
    timeoutMs: z.number().int().min(0).optional(),
    resolvedBy: z.string().optional(),
  });
  export type PolicyObligation = z.infer<typeof PolicyObligation>;

  export const PolicyDecision = z.object({
    policyId: z.string(),
    policyVersion: z.string().optional(),
    verdict: z.enum(["allow", "deny", "pending"]),
    effects: z.array(PolicyEffect),
    obligations: z.array(PolicyObligation).optional(),
    reasonCodes: z.array(z.string()),
    factsUsed: z.array(z.string()).optional(),
    durationMs: z.number().min(0).optional(),
  });
  export type PolicyDecision = z.infer<typeof PolicyDecision>;

  export const EffectiveDecision = z.object({
    verdict: z.enum(["allow", "deny", "pending"]),
    mergedEffects: z.array(PolicyEffect),
    obligations: z.array(PolicyObligation),
    contributingPolicies: z.array(z.string()),
  });
  export type EffectiveDecision = z.infer<typeof EffectiveDecision>;

  export type PolicyPointResolver = (
    timing: Timing,
    context?: { resourceKind?: string },
  ) => string[];

  const policyPointIds = [
    "session.inbound.pre",
    "run.lifecycle.pre",
    "run.turn.pre",
    "prompt.context.pre",
    "tool.catalog.pre",
    "connection.llm.pre",
    "connection.llm.post",
    "tool.native.pre",
    "tool.mcp.pre",
    "delegation.subagent.pre",
    "delegation.background.pre",
    "tool.native.post",
    "tool.mcp.post",
    "delegation.subagent.post",
    "delegation.background.post",
    "run.turn.post",
    "run.completion.pre",
    "session.writeback.pre",
    "run.lifecycle.post",
    "run.error.error",
  ] as const;

  const policyPoint = z.object({
    point: z.enum(Object.values(Timing) as [string, ...string[]]),
    allowedEffects: z.array(PolicyEffectType),
    defaultFailPolicy: FailPolicy,
  });

  type RegisteredPolicyPointId = (typeof policyPointIds)[number];

  const PolicyPointId = z
    .string()
    .regex(
      /^(tool|prompt|delegation|session|credential|connection|run)\.[a-z][a-z0-9-]*\.(load|pre|post|error)$/,
    );
  const PolicyPointContract = z.object({
    id: PolicyPointId,
    version: z.number().int().min(1),
    phase: z.enum(["pre", "post", "error"]),
    resourceKinds: z.array(z.string()),
    inputSchema: z.string(),
    requiredContext: z.array(z.string()),
    allowedEffects: z.array(PolicyEffectType),
    defaultFailPolicy: FailPolicy,
    sideEffectBoundary: z.boolean(),
  });
  type PolicyPointContract = z.infer<typeof PolicyPointContract>;

  const contract = (
    id: RegisteredPolicyPointId,
    phase: PolicyPointContract["phase"],
    resourceKinds: readonly string[],
    requiredContext: readonly string[],
    allowedEffects: readonly PolicyEffectType[],
    defaultFailPolicy: PolicyPointContract["defaultFailPolicy"],
    sideEffectBoundary: boolean,
  ): PolicyPointContract => ({
    id,
    version: 1,
    phase,
    resourceKinds: [...resourceKinds],
    inputSchema: `policy.point.${id}.input.v1`,
    requiredContext: [...requiredContext],
    allowedEffects: [...allowedEffects],
    defaultFailPolicy,
    sideEffectBoundary,
  });

  const preBoundary = ["fail-closed", true] as const;
  const postBoundary = ["fail-open", false] as const;

  const PolicyPointRegistry = {
    "session.inbound.pre": contract(
      "session.inbound.pre",
      "pre",
      ["session"],
      ["actorId", "sessionId", "inboundEvent"],
      ["audit.annotate", "run.abort", "delegation.set_constraints"],
      ...preBoundary,
    ),
    "run.lifecycle.pre": contract(
      "run.lifecycle.pre",
      "pre",
      ["run"],
      ["actorId", "sessionId", "runId"],
      ["audit.annotate", "run.abort", "delegation.set_constraints", "prompt.append_context"],
      ...preBoundary,
    ),
    "run.turn.pre": contract(
      "run.turn.pre",
      "pre",
      ["run"],
      ["sessionId", "runId", "turnIndex"],
      ["audit.annotate", "run.abort", "run.retry_after", "prompt.append_context"],
      ...preBoundary,
    ),
    "prompt.context.pre": contract(
      "prompt.context.pre",
      "pre",
      ["prompt"],
      ["sessionId", "runId", "turnIndex"],
      ["prompt.append_context", "prompt.inject_message", "prompt.replace", "audit.annotate"],
      "fail-open",
      true,
    ),
    "tool.catalog.pre": contract(
      "tool.catalog.pre",
      "pre",
      ["tool"],
      ["sessionId", "runId", "availableTools"],
      ["tool.filter", "audit.annotate", "run.abort"],
      ...preBoundary,
    ),
    "connection.llm.pre": contract(
      "connection.llm.pre",
      "pre",
      ["connection"],
      ["sessionId", "runId", "modelId"],
      ["prompt.append_context", "prompt.inject_message", "run.abort", "audit.annotate"],
      ...preBoundary,
    ),
    "connection.llm.post": contract(
      "connection.llm.post",
      "post",
      ["connection"],
      ["sessionId", "runId", "modelId", "responseTokens"],
      ["audit.annotate", "run.abort", "run.continue_with_prompt"],
      ...postBoundary,
    ),
    "tool.native.pre": contract(
      "tool.native.pre",
      "pre",
      ["tool"],
      ["sessionId", "runId", "toolId", "toolInput"],
      ["tool.filter", "tool.rewrite_input", "tool.require_approval", "run.abort", "audit.annotate"],
      ...preBoundary,
    ),
    "tool.mcp.pre": contract(
      "tool.mcp.pre",
      "pre",
      ["tool"],
      ["sessionId", "runId", "toolId", "mcpServerId", "toolInput"],
      ["tool.filter", "tool.rewrite_input", "tool.require_approval", "run.abort", "audit.annotate"],
      ...preBoundary,
    ),
    "delegation.subagent.pre": contract(
      "delegation.subagent.pre",
      "pre",
      ["worker"],
      ["sessionId", "runId", "subagentId", "subagentProfile"],
      ["delegation.set_constraints", "delegation.require_approval", "run.abort", "audit.annotate"],
      ...preBoundary,
    ),
    "delegation.background.pre": contract(
      "delegation.background.pre",
      "pre",
      ["worker"],
      ["sessionId", "runId", "backgroundTaskId"],
      ["delegation.set_constraints", "delegation.require_approval", "run.abort", "audit.annotate"],
      ...preBoundary,
    ),
    "tool.native.post": contract(
      "tool.native.post",
      "post",
      ["tool"],
      ["sessionId", "runId", "toolId", "toolResult"],
      ["audit.annotate", "run.abort"],
      ...postBoundary,
    ),
    "tool.mcp.post": contract(
      "tool.mcp.post",
      "post",
      ["tool"],
      ["sessionId", "runId", "toolId", "mcpServerId", "toolResult"],
      ["audit.annotate", "run.abort"],
      ...postBoundary,
    ),
    "delegation.subagent.post": contract(
      "delegation.subagent.post",
      "post",
      ["worker"],
      ["sessionId", "runId", "subagentId", "subagentResult"],
      ["audit.annotate"],
      ...postBoundary,
    ),
    "delegation.background.post": contract(
      "delegation.background.post",
      "post",
      ["worker"],
      ["sessionId", "runId", "backgroundTaskId", "taskResult"],
      ["audit.annotate"],
      ...postBoundary,
    ),
    "run.turn.post": contract(
      "run.turn.post",
      "post",
      ["run"],
      ["sessionId", "runId", "turnIndex", "turnResult"],
      ["audit.annotate", "run.abort", "run.continue_with_prompt"],
      ...postBoundary,
    ),
    "run.completion.pre": contract(
      "run.completion.pre",
      "pre",
      ["run"],
      ["sessionId", "runId", "completionCandidate"],
      ["audit.annotate", "run.abort", "prompt.append_context"],
      ...preBoundary,
    ),
    "session.writeback.pre": contract(
      "session.writeback.pre",
      "pre",
      ["session"],
      ["sessionId", "runId", "writebackPayload"],
      ["audit.annotate", "run.abort"],
      ...preBoundary,
    ),
    "run.lifecycle.post": contract(
      "run.lifecycle.post",
      "post",
      ["run"],
      ["sessionId", "runId", "runOutcome"],
      ["audit.annotate"],
      ...postBoundary,
    ),
    "run.error.error": contract(
      "run.error.error",
      "error",
      ["run"],
      ["sessionId", "runId", "errorCode", "errorPhase"],
      ["audit.annotate", "run.abort", "run.retry_after"],
      "fail-closed",
      false,
    ),
  } satisfies Record<RegisteredPolicyPointId, PolicyPointContract>;

  const policyPointMigrationMapping = {
    [Timing.INBOUND_RECEIVE]: ["session.inbound.pre"],
    [Timing.RUN_START]: ["run.lifecycle.pre"],
    [Timing.TURN_START]: ["run.turn.pre"],
    [Timing.CONTEXT_PREPARE]: ["prompt.context.pre"],
    [Timing.RESOURCES_PREPARE]: ["tool.catalog.pre"],
    [Timing.MODEL_REQUEST]: ["connection.llm.pre"],
    [Timing.MODEL_RESPONSE]: ["connection.llm.post"],
    [Timing.INVOKE_PREPARE]: [
      "tool.native.pre",
      "tool.mcp.pre",
      "delegation.subagent.pre",
      "delegation.background.pre",
    ],
    [Timing.INVOKE_RESULT]: [
      "tool.native.post",
      "tool.mcp.post",
      "delegation.subagent.post",
      "delegation.background.post",
    ],
    [Timing.TURN_FINISH]: ["run.turn.post"],
    [Timing.COMPLETION_PREPARE]: ["run.completion.pre"],
    [Timing.WRITEBACK_COMMIT]: ["session.writeback.pre"],
    [Timing.RUN_FINISH]: ["run.lifecycle.post"],
    [Timing.ERROR]: ["run.error.error"],
  } satisfies Record<Timing, RegisteredPolicyPointId[]>;

  export const PolicyPoint = Object.assign(policyPoint, {
    version: policyKernelVersion,
    Id: PolicyPointId,
    Contract: PolicyPointContract,
    RegistrySchema: z.record(PolicyPointId, PolicyPointContract),
    Registry: PolicyPointRegistry,
    MigrationMapping: policyPointMigrationMapping,
    resolve: undefined as unknown as PolicyPointResolver,
  });
  export type PolicyPoint = z.infer<typeof policyPoint> & {
    MigrationMapping: Record<Timing, RegisteredPolicyPointId[]>;
    resolve: PolicyPointResolver;
  };

  export const PolicyPlan = z.object({
    policies: z.array(
      z.object({
        id: z.string().min(1),
        required: z.boolean(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    labels: z.array(z.string()),
    registryVersion: z.string().optional(),
  });
  export type PolicyPlan = z.infer<typeof PolicyPlan>;

  export const SystemPromptResult = z.object({
    systemPrompt: z.string().optional(),
    prependContext: z.string().optional(),
    appendContext: z.string().optional(),
  });
  export type SystemPromptResult = z.infer<typeof SystemPromptResult>;
}

export namespace RuntimeResource {
  export const schemaVersion = policyKernelVersion;

  export const Kind = z.enum([
    "tool",
    "skill",
    "mcpSource",
    "worker",
    "credential",
    "session",
    "policy",
  ]);
  export type Kind = z.infer<typeof Kind>;

  export const Source = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("system"),
    }),
    z.object({
      type: z.literal("mcp"),
      serverId: z.string().optional(),
      remoteName: z.string().optional(),
    }),
    z.object({
      type: z.literal("skill-mcp"),
      serverId: z.string().optional(),
      remoteName: z.string().optional(),
      skillId: z.string().optional(),
    }),
    z.object({
      type: z.literal("agent"),
      agentId: z.string().optional(),
      agentProfileRef: z.string().optional(),
    }),
    z.object({
      type: z.literal("server"),
      serverId: z.string().optional(),
      remoteName: z.string().optional(),
    }),
    z.object({
      type: z.literal("project"),
      projectId: z.string().optional(),
      path: z.string().optional(),
    }),
    z.object({
      type: z.literal("user"),
      userId: z.string().optional(),
    }),
    z.object({
      type: z.literal("global"),
      scope: z.string().optional(),
    }),
    z.object({
      type: z.literal("coordinator"),
      coordinatorId: z.string().optional(),
      workerId: z.string().optional(),
    }),
    z.object({
      type: z.literal("runtime"),
      runtimeId: z.string().optional(),
    }),
    z.object({
      type: z.literal("file"),
      path: z.string().optional(),
      filePath: z.string().optional(),
    }),
  ]);
  export type Source = z.infer<typeof Source>;

  export const ActorType = z.enum(["user", "agent", "system"]);
  export type ActorType = z.infer<typeof ActorType>;

  export const SessionType = z.enum(["root", "child", "self-loop"]);
  export type SessionType = z.infer<typeof SessionType>;

  export const ActorDescriptor = z.object({
    actorId: z.string().min(1),
    actorType: ActorType,
    agentProfileRef: z.string().optional(),
    permissions: z.array(z.string()),
    labels: z.array(z.string()).optional(),
    digest: z.string().optional(),
  });
  export type ActorDescriptor = z.infer<typeof ActorDescriptor>;

  export const SessionDescriptor = z.object({
    sessionId: z.string().min(1),
    parentSessionId: z.string().optional(),
    sessionType: SessionType,
    ownerActorId: z.string().min(1),
    digest: z.string().optional(),
  });
  export type SessionDescriptor = z.infer<typeof SessionDescriptor>;

  export const Descriptor = z
    .object({
      id: z.string().min(1),
      kind: Kind,
      version: z.string().optional(),
      labels: z.array(z.string()),
      capabilities: z.array(z.string()),
      effects: z.array(z.string()),
      risk: z.number().optional(),
      source: Source.optional(),
      schemaRef: z.string().optional(),
      digest: z.string().optional(),
      owner: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      const segments = value.id.split(":");
      const hasValidSegments = segments.length === 2 || segments.length === 3;

      if (!hasValidSegments) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "id must use kind:name or kind:source:name format",
        });
        return;
      }

      if (segments.some((segment) => segment.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "id segments must not be empty",
        });
      }

      if (segments[0] !== value.kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "id kind segment must match kind",
        });
      }

      if (value.kind === "tool") {
        if (value.source === undefined && segments.length !== 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["id"],
            message: "descriptor source metadata requires a three-segment id",
          });
        }

        if (value.source !== undefined && segments.length !== 3) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["id"],
            message: "descriptor source metadata must match the id source segment",
          });
        }

        if (value.source !== undefined && segments[1] !== value.source.type) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["id"],
            message: "id source segment must match source.type",
          });
        }
      }
    });
  export type Descriptor = z.infer<typeof Descriptor>;

  type DescriptorInput = {
    id: string;
    kind: Kind;
    labels?: string[];
    capabilities?: string[];
    effects?: string[];
    source?: Source;
    schemaRef?: string;
    digest?: string;
    owner?: string;
    version?: string;
    risk?: number;
  };

  function createDescriptor(input: DescriptorInput): Descriptor {
    return Descriptor.parse({
      labels: [],
      capabilities: [],
      effects: [],
      ...input,
    });
  }

  export function createWorkerDescriptor(workerId: string, opts?: { source?: string }): Descriptor {
    return createDescriptor({
      id: `worker:coordinator:${workerId}`,
      kind: "worker",
      labels: ["source.coordinator", "worker.coordinator"],
      source:
        opts?.source === undefined
          ? { type: "coordinator" }
          : { type: "coordinator", coordinatorId: opts.source },
    });
  }

  export function createCredentialDescriptor(
    provider: string,
    credType: string,
    opts?: { source?: string },
  ): Descriptor {
    return createDescriptor({
      id: `credential:${provider}:${credType}`,
      kind: "credential",
      labels: ["source.file", `credential.${provider}`],
      source: opts?.source === undefined ? { type: "file" } : { type: "file", path: opts.source },
    });
  }

  export function createSessionDescriptor(
    sessionId: string,
    sessionType: string,
    opts?: { parentSessionId?: string; ownerActorId?: string },
  ): Descriptor {
    const labels = ["source.runtime", `session.${sessionType}`];

    if (opts?.parentSessionId !== undefined) {
      labels.push(`session.parent:${opts.parentSessionId}`);
    }

    return createDescriptor({
      id: `session:${sessionId}`,
      kind: "session",
      labels,
      source: { type: "runtime", runtimeId: sessionId },
      ...(opts?.ownerActorId === undefined ? {} : { owner: opts.ownerActorId }),
    });
  }
}
