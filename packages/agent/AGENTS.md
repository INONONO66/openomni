# packages/agent

`ChatAgent` — a stateless LLM + tool ReAct loop driven by a policy engine — plus the multi-agent runtime (registry, subagent / background tools, MCP client). Depends on `@openomni/protocol`, `@openomni/llm`, and `@openomni/session` (for observability: Log, Bus, Telemetry, TraceContext).

## STRUCTURE

```
src/
├── index.ts                    # Public API
├── core/
│   ├── index.ts                # Core re-exports (ChatAgent, types)
│   ├── chat-agent.ts           # ChatAgent.create() — wraps streamAgent + provides run() / stream()
│   ├── types.ts                # ChatAgentConfig, ChatAgentInput, AgentResult, AgentStep, AgentEvent, AgentBudget, TokenUsage, Sink, legacy hook types
│   ├── budget.ts               # createBudgetState / checkBudget / recordTurn / recordToolCall / recordTokenUsage
│   ├── retry.ts                # DEFAULT_RETRY_POLICY, classifyRetryReason, shouldRetry, sleep
│   ├── delegation.ts           # DelegationContext + checkDelegation (depth / circular detection)
│   ├── runtime-context.ts      # Runtime context helpers for agent execution
│   ├── tool-guard.ts           # ToolGuard.check — evaluates permission via PolicyEngine.evaluatePermission()
│   ├── prompt-builder.ts       # System prompt composition helpers
│   ├── message-factory.ts      # Message envelope helpers for injected messages
│   ├── telemetry.ts            # Telemetry.span / counter / histogram (OpenTelemetry; disabled by default)
│   ├── execution/
│   │   ├── stream-engine.ts    # streamAgent() — retry loop + turn loop + policy dispatch
│   │   ├── tool-executor.ts    # Wraps user toolExecutor with pre_tool_use / post_tool_use dispatch
│   │   └── compaction.ts       # InMemoryCompactor for message compression
│   ├── policy/
│   │   ├── engine.ts           # PolicyEngine.create() — register, freeze, dispatch, dispatchSystemPrompt, evaluatePermission
│   │   ├── types.ts            # PolicyContext, PolicyFn, PolicyRegistration, PolicyEngineInstance, PolicyVerdict
│   │   └── index.ts            # Re-exports PolicyEngine + types
│   └── middleware/             # Deprecated compat bridge — wraps PolicyEngine for legacy consumers
│       ├── engine.ts           # MiddlewareEngine.create() (delegates to PolicyEngine)
│       ├── types.ts            # Type aliases: MiddlewareContext = PolicyContext, MiddlewareRegistration = PolicyRegistration
│       └── builtin/
│           ├── budget.ts       # createBudgetReassuranceMiddleware / createBudgetWarningMiddleware
│           ├── compaction.ts   # createCompactionMiddleware (post_compaction)
│           ├── post-tool.ts    # createPostToolMiddleware (post_tool_use)
│           ├── post-turn.ts    # createPostTurnMiddleware (post_turn)
│           ├── idle-nudge.ts   # createIdleNudgeMiddleware (pre_turn + post_tool_use)
│           └── tool-guard.ts   # createToolGuardMiddleware (pre_tool_use, fail-closed)
└── runtime/
    ├── index.ts                # Re-exports registry / tools / mcp
    ├── registry/
    │   └── registry.ts         # AgentRegistry.define / get / list / override (AgentProfile.Definition store)
    ├── tools/
    │   ├── subagent.ts         # SubagentTool — spawn / send / background with delegation checks
    │   ├── background-output.ts# BackgroundOutputTool — block / poll a background task result
    │   └── background-cancel.ts# BackgroundCancelTool — cancel a running background task
    └── mcp/
        ├── client.ts           # McpClient — connect / disconnect / listTools / callTool (stdio / sse / http)
        └── types.ts            # McpServerConfig + tool conversion types
```

## PUBLIC API

```typescript
import { ChatAgent, PolicyEngine } from "@openomni/agent";

const agent = ChatAgent.create({
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  systemPrompt: "You are a helpful assistant.",
  tools: [],
  budget: { maxTurns: 10, maxToolCalls: 20 },
  policies: [
    /* PolicyRegistration[] (see below) */
  ],
});

const result = await agent.run({
  messages: [{ role: "user", content: "Hello!" }],
});
// result.finishReason: 'stop' | 'tool-calls' | 'max-steps' | 'handoff'
// result.text / result.steps / result.usage
```

Also exported from `@openomni/agent`:

- Types: `ChatAgentConfig`, `ChatAgentInput`, `AgentResult`, `AgentStep`, `AgentEvent`, `AgentBudget`, `TokenUsage`, `Sink`, `StepGuardVerdict`, `StepGuardContext`, `AgentEventEmitter`, `ExecutionHooks`, `HookContext`, `HookVerdict`
- Policy: `PolicyEngine`, `PolicyContext`, `PolicyFn`, `PolicyRegistration`, `PolicyVerdict`, `PolicyDecision`, `PolicyEngineConfig`, `PolicyEngineInstance`, `PolicyAuditConfig`, `PolicySystemPromptVerdict`
- Middleware _(deprecated)_: `MiddlewareEngine`, `MiddlewareContext`, `MiddlewareFn`, `MiddlewareRegistration`, `MiddlewareDecision`, `MiddlewareEngineConfig`, `MiddlewareEngineInstance`
- Runtime: `AgentRegistry`, `SubagentTool`, `SubagentToolOptions`, `BackgroundOutputTool`, `BackgroundCancelTool`, `McpClient`, `McpServerConfig`

## ChatAgentConfig

| Field            | Type                                     | Description                                                                 |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `model`          | `{ provider: string; id: string }`       | Required LLM provider + model id                                            |
| `systemPrompt?`  | `string`                                 | Base system prompt                                                          |
| `tools?`         | `Tool.Spec[]`                            | Tool specs available to the LLM                                             |
| `budget?`        | `AgentBudget`                            | Max turns / tool calls / wall time / tool runtime (use `-1` for unlimited)  |
| `toolExecutor?`  | `(call) => Promise<Tool.Result>`         | Custom tool executor; wrapped by `createToolExecutor`                       |
| `signal?`        | `AbortSignal`                            | External cancellation                                                       |
| `permissions?`   | `Policy.Permission`                      | Evaluated by the built-in `tool-guard` policy                               |
| `compaction?`    | `{ contextWindowTokens, ... }`           | Trigger message compaction via `InMemoryCompactor`                          |
| `policies?`      | `PolicyRegistration[]`                   | **Preferred extension mechanism** — replaces `middleware`                   |
| `middleware?`    | `PolicyRegistration[]`                   | _(deprecated alias for `policies`)_                                         |
| `eventEmitter?`  | `AgentEventEmitter`                      | Optional event emitter for external observers                               |
| `providerOptions?` | `Record<string, unknown>`              | Forwarded to the underlying provider SDK                                    |

## POLICY ENGINE

The policy engine is the extension surface. Every turn dispatches through timings defined in `@openomni/protocol` `Policy.Timing`. The core agent timings:

```
pre_run → pre_turn → on_system_prompt → pre_tool_use → post_tool_use
        → post_turn → post_compaction → post_run → on_error
```

Additional timings exist for orchestration layers: `pre_ingress`, `post_ingress`, `pre_dispatch`, `post_dispatch`, `pre_tool_selection`, `post_tool_selection`, `pre_delegation`, `post_delegation`, `pre_memory_access`, `post_memory_access`, `pre_artifact_write`, `post_artifact_write`.

### API

- `PolicyEngine.create(config?)` — creates a new `PolicyEngineInstance`. Config options: `onDecision` callback, `traceContext`, `audit` (durable EventLog recording, enabled by default).
- `instance.register(policy)` — adds a `PolicyRegistration` to the engine. Must be called before `freeze()`.
- `instance.freeze()` — prevents further registration. Called before dispatch begins.
- `instance.dispatch(timing, ctx)` — runs all policies matching the timing in priority order. Returns the first non-`continue` verdict, or `continue` if all pass.
- `instance.dispatchSystemPrompt(ctx)` — runs only the `on_system_prompt` chain with transform chaining: first `systemPrompt` transform wins, `prependContext` / `appendContext` concatenate, `inject` appends.
- `PolicyEngine.evaluatePermission(permission, request)` — evaluates a `Policy.Permission` against a `Policy.EvaluationRequest`. Checks input rules (priority-sorted), denylist, requireApproval, and allowlist. Returns `Guardrail.EvaluationResult`.
- `instance.deriveChildPolicies()` — returns shallow-cloned registrations where `propagate: true`, for inheritance by child agents.

### PolicyContext\<T\>

Generic context passed to every policy function:

- **Common fields**: `timing`, `action?`, `resource?`, `input?`, `actor?`, `resourceMeta?`, `metadata?`, `tools?`, `agentType?`, `traceContext?`, `envelope?`
- **Turn-specific fields**: `steps?`, `usage?`, `turnCount?`, `isCompletion?`, `continuationCount?`, `elapsedMs?`, `messages?`, `budgetState?`, `eventEmitter?`, `budget?`
- **Tool-specific fields**: `toolName?`, `toolCallId?`, `toolInput?`, `toolOutput?`
- **Generic data**: `data?: T` — action-specific payload

### Registration

`PolicyRegistration { name, timing, priority, scope?, failPolicy?, fn, propagate? }`. Lower `priority` runs first; `scope.agentType` optionally filters by agent kind; `failPolicy` is `fail-open` (default) or `fail-closed`; `timing` can be a single timing or an array of timings.

### Verdict

`Policy.Verdict`: `continue | skip | abort | retry | transform | inject | deny`. The first non-`continue` verdict terminates the chain for that timing. Non-`continue` verdicts must include a `reason` (enforced in non-production; warned in production).

### Audit

Every policy decision is recorded to `EventLog` as a `policy_evaluated` event by default. Includes `policyId`, `actor`, `action`, `resource`, `verdict`, `reason`, `actionId`, and `visibility`. Disable with `audit: false` in engine config.

### Builtins (priority in parentheses)

- `tool-guard` (0, fail-closed) — enforces `Policy.Permission` and `InputRule`; returns `skip` / `abort` / `require_approval`
- `budget-reassurance` (10) — injects a reassurance system message around 60% budget
- `budget-warning` (20) — injects a warning around 80% budget
- `post-tool` (200) — user-supplied tool-output enricher
- `post-turn` (250) — user-supplied post-turn judgement (continuation / abort)
- `idle-nudge` (300) — detects idle ≥ threshold (default 60s), injects a nudge; after `maxNudges` (default 3) aborts with reason `stalled`
- `compaction` (900) — triggers `InMemoryCompactor.compact()` when token threshold is exceeded

### Backward compat (`middleware/engine.ts`)

`MiddlewareEngine.create()` wraps `PolicyEngine` and maps `deny` → `abort` for callers still using `Hook.Verdict`. Type aliases in `middleware/types.ts` map `MiddlewareContext` → `PolicyContext` and `MiddlewareRegistration` → `PolicyRegistration`. Deprecated — new code should use `PolicyEngine` directly.

## TURN LIFECYCLE (StreamEngine)

```
streamAgent(input, config, sink) [AsyncGenerator<AgentEvent>]
  ├─ retry loop (maxAttempts)
  │   ├─ build PolicyEngine (builtins + config.policies + freeze)
  │   ├─ dispatch(pre_run)                    → inject / abort / continue
  │   └─ turn loop (while budget ok)
  │       ├─ checkBudget → if exceeded, dispatch(post_run) + yield complete
  │       ├─ dispatch(pre_turn)               → budget warnings, idle-nudge
  │       ├─ dispatch(on_system_prompt)       → identity, context enrichment
  │       ├─ llmRun via @openomni/llm
  │       │    └─ tool calls flow through createToolExecutor:
  │       │         ├─ dispatch(pre_tool_use)  → tool-guard (fail-closed)
  │       │         ├─ execute tool
  │       │         └─ dispatch(post_tool_use) → idle-nudge reset, enrichment
  │       ├─ outcome === "stop"?
  │       │    ├─ dispatch(post_turn)         → inject (continue) / abort / complete
  │       │    ├─ if inject: dispatch(post_compaction) → loop
  │       │    └─ else: dispatch(post_run) + yield complete
  │       └─ outcome === "error"/"aborted"?
  │            └─ dispatch(on_error) → retry (shouldRetry) or throw
```

## RUNTIME (MULTI-AGENT)

- **AgentRegistry** — global in-memory store of `AgentProfile.Definition` entries keyed by `name`. `define`, `get`, `has`, `list`, `override`, `clear`.
- **SubagentTool** — tool spec that delegates to another agent through the orchestration layer. Checks `DelegationContext` (depth, circular visited set) before calling `subagentRuntime.spawn / send` or, when `background: true`, a `backgroundManager`. Only policies with `propagate: true` are inherited via `deriveChildPolicies()`.
- **BackgroundOutputTool / BackgroundCancelTool** — companions to the background path. Fetch or cancel results by `task_id`.
- **McpClient** — wraps the MCP SDK. Connects via stdio / SSE / streamable HTTP. `listTools()` / `callTool()` convert MCP tool specs and results to `Tool.Spec` / `Tool.Result`.

## KEY PATTERNS

- **Stateless core**: Every `ChatAgent.run()` is independent — no session mutation, no storage. State (budget, delegation) lives on a per-call context.
- **Sink-driven**: Callers pass a `Sink` (from `@openomni/protocol`) to receive streaming output. The agent never creates sessions on its own.
- **Policy > middleware**: New extensions MUST use `policies: [...]` with `PolicyRegistration`. The `middleware/` directory is a deprecated compat bridge wrapping `PolicyEngine`.
- **Budget check before each turn**: `checkBudget()` runs before `llmRun()`, not after, so budget enforcement blocks the next turn cleanly.
- **Delegation safety**: `DelegationContext` with `visitedAgents: Set<string>` and `maxDepth` prevents circular / runaway delegation.
- **Message format**: `ChatAgentInput.messages` is a simple `{ role: "user" | "assistant"; content: string }[]`. Richer `Message.WithParts[]` is used internally only.

## ANTI-PATTERNS

- Agent depends on `@openomni/session` for observability only (Log, Bus, Telemetry, TraceContext). Do NOT use session for state management — orchestration that needs session state lives in `@openomni/openomni`.
- Do NOT use `MiddlewareEngine` for new code. Use `PolicyEngine` directly — `MiddlewareEngine` is a deprecated compat bridge.
- Do NOT add new `ExecutionHooks` / `stepGuard` callers. Extend behavior via `policies: [...]`.
- Do NOT bypass `ToolGuard.check` by returning placeholder tool results in user code; use a `pre_tool_use` policy so behavior is uniform.
- Do NOT call `Guardrail.evaluate()` directly. Use `PolicyEngine.evaluatePermission()` — it is the canonical permission evaluation entry point.
