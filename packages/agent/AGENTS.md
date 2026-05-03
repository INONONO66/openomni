# packages/agent

`ChatAgent` — a stateless LLM + tool ReAct loop driven by a middleware engine — plus the multi-agent runtime (messenger, registry, subagent / background tools, MCP client). Depends on `@openomni/protocol`, `@openomni/llm`, and `@openomni/session` (for observability: Log, Bus, Telemetry, TraceContext).

## STRUCTURE

```
src/
├── index.ts                    # Public API
├── core/
│   ├── index.ts                # Core re-exports (ChatAgent, types, Memory)
│   ├── chat-agent.ts           # ChatAgent.create() — wraps streamAgent + provides run() / stream()
│   ├── types.ts                # ChatAgentConfig, ChatAgentInput, AgentResult, AgentStep, AgentEvent, AgentBudget, TokenUsage, Sink, legacy hook types
│   ├── budget.ts               # createBudgetState / checkBudget / recordTurn / recordToolCall / recordTokenUsage
│   ├── retry.ts                # DEFAULT_RETRY_POLICY, classifyRetryReason, shouldRetry, sleep
│   ├── delegation.ts           # DelegationContext + checkDelegation (depth / circular detection)
│   ├── memory.ts               # Memory interface + InMemoryMemory (Jaccard retrieval)
│   ├── tool-guard.ts           # ToolGuard.check — evaluates Guardrail.Permission + InputRule list
│   ├── prompt-builder.ts       # System prompt composition helpers
│   ├── message-factory.ts      # Message envelope helpers for injected messages
│   ├── telemetry.ts            # Telemetry.span / counter / histogram (OpenTelemetry; disabled by default)
│   ├── execution/
│   │   ├── stream-engine.ts    # streamAgent() — retry loop + turn loop + middleware dispatch
│   │   ├── tool-executor.ts    # Wraps user toolExecutor with pre_tool_use / post_tool_use dispatch
│   │   └── compaction.ts       # InMemoryCompactor for message compression
│   └── middleware/
│       ├── engine.ts           # MiddlewareEngine.create() — register, dispatch, dispatchSystemPrompt
│       ├── types.ts            # MiddlewareContext, MiddlewareFn, MiddlewareRegistration
│       ├── compat.ts           # Backward compat: fromExecutionHooks / fromStepGuard / fromConfig
│       └── builtin/
│           ├── budget.ts       # createBudgetReassuranceMiddleware / createBudgetWarningMiddleware
│           ├── memory.ts       # createMemoryMiddleware (on_system_prompt)
│           ├── compaction.ts   # createCompactionMiddleware (post_compaction)
│           ├── post-tool.ts    # createPostToolMiddleware (post_tool_use)
│           ├── post-turn.ts    # createPostTurnMiddleware (post_turn)
│           ├── idle-nudge.ts   # createIdleNudgeMiddleware (pre_turn + post_tool_use)
│           └── tool-guard.ts   # createToolGuardMiddleware (pre_tool_use, fail-closed)
└── runtime/
    ├── index.ts                # Re-exports messenger / registry / tools / mcp
    ├── messenger/
    │   ├── messenger.ts        # AgentMessenger.create — send / subscribe / request with correlationId
    │   ├── transport.ts        # BusTransport — Transport interface implementation over @openomni/session Bus
    │   └── instance-registry.ts# InstanceRegistry — track live agent instances by ID + status
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
import { ChatAgent, MiddlewareEngine } from "@openomni/agent";

const agent = ChatAgent.create({
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  systemPrompt: "You are a helpful assistant.",
  tools: [],
  budget: { maxTurns: 10, maxToolCalls: 20 },
  middleware: [
    /* registrations (see below) */
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
- Middleware: `MiddlewareEngine`, `MiddlewareContext`, `MiddlewareFn`, `MiddlewareRegistration`, `MiddlewareEngineInstance`
- Runtime: `AgentMessenger`, `BusTransport`, `Transport`, `AgentMessengerOptions`, `AgentRegistry`, `SubagentTool`, `SubagentToolOptions`, `BackgroundOutputTool`, `BackgroundCancelTool`, `McpClient`, `McpServerConfig`

## ChatAgentConfig

| Field            | Type                                     | Description                                                                 |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `model`          | `{ provider: string; id: string }`       | Required LLM provider + model id                                            |
| `systemPrompt?`  | `string`                                 | Base system prompt                                                          |
| `tools?`         | `Tool.Spec[]`                            | Tool specs available to the LLM                                             |
| `budget?`        | `AgentBudget`                            | Max turns / tool calls / wall time / tool runtime (use `-1` for unlimited)  |
| `toolExecutor?`  | `(call) => Promise<Tool.Result>`         | Custom tool executor; wrapped by `createToolExecutor`                       |
| `signal?`        | `AbortSignal`                            | External cancellation                                                       |
| `permissions?`   | `Guardrail.Permission`                   | Evaluated by the built-in `tool-guard` middleware                           |
| `compaction?`    | `{ contextWindowTokens, ... }`           | Trigger message compaction via `InMemoryCompactor`                          |
| `memory?`        | `Memory`                                 | Memory interface retrieved by the `memory` middleware                       |
| `middleware?`    | `MiddlewareRegistration[]`               | **Preferred extension mechanism**                                           |
| `stepGuard?`     | _(deprecated)_                           | Legacy post_turn guard — routed through `middleware/compat.ts`              |
| `hooks?`         | _(deprecated)_                           | Legacy `ExecutionHooks` — routed through `middleware/compat.ts`             |
| `eventEmitter?`  | `AgentEventEmitter`                      | Optional event emitter for external observers                               |
| `providerOptions?` | `Record<string, unknown>`              | Forwarded to the underlying provider SDK                                    |

## MIDDLEWARE ENGINE

The middleware engine is the extension surface. Every turn dispatches through 9 timings (defined in `@openomni/protocol` `Hook.Timing`):

```
pre_run → pre_turn → on_system_prompt → pre_tool_use → post_tool_use
        → post_turn → post_compaction → post_run → on_error
```

- **Registration**: `MiddlewareRegistration { name, timing, priority, scope?, failPolicy?, fn, propagate? }`. Lower `priority` runs first; `scope.agentType` optionally filters by agent kind; `failPolicy` is `fail-open` (default) or `fail-closed`.
- **Verdict** (`Hook.Verdict`): `continue | skip | abort | retry | transform | inject`. The first non-`continue` verdict terminates the chain for that timing.
- **System prompt transforms**: `dispatchSystemPrompt()` runs only the `on_system_prompt` chain and supports transform chaining so multiple middlewares can contribute.
- **Builtins** (priority in parentheses):
  - `tool-guard` (0, fail-closed) — enforces `Guardrail.Permission` and `InputRule`; returns `skip` / `abort` / `require_approval`
  - `budget-reassurance` (10) — injects a reassurance system message around 60% budget
  - `budget-warning` (20) — injects a warning around 80% budget
  - `memory` (100) — appends similar memory entries to the system prompt
  - `post-tool` (200) — user-supplied tool-output enricher
  - `post-turn` (250) — user-supplied post-turn judgement (continuation / abort)
  - `idle-nudge` (300) — detects idle ≥ threshold (default 60s), injects a nudge; after `maxNudges` (default 3) aborts with reason `stalled`
  - `compaction` (900) — triggers `InMemoryCompactor.compact()` when token threshold is exceeded
- **Backward compat** (`middleware/compat.ts`): `fromExecutionHooks`, `fromStepGuard`, `fromConfig` translate legacy `hooks` / `stepGuard` config into middleware registrations. Still active; emit deprecation-friendly types.

## TURN LIFECYCLE (StreamEngine)

```
streamAgent(input, config, sink) [AsyncGenerator<AgentEvent>]
  ├─ retry loop (maxAttempts)
  │   ├─ build MiddlewareEngine (builtins + config.middleware + compat bridges)
  │   ├─ dispatch(pre_run)                    → inject / abort / continue
  │   └─ turn loop (while budget ok)
  │       ├─ checkBudget → if exceeded, dispatch(post_run) + yield complete
  │       ├─ dispatch(pre_turn)               → budget warnings, idle-nudge
  │       ├─ dispatch(on_system_prompt)       → memory enrichment, identity
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
- **AgentMessenger** + **BusTransport** — `send` / `subscribe` / `request` with `correlationId` matching, timeout, and abort signal support. Transport is pluggable; `BusTransport` maps `Messenger.MessageEnvelope` onto `@openomni/session` `Bus`.
- **InstanceRegistry** — track live agent instances (id, agentId, status `idle | busy | error`, metadata).
- **SubagentTool** — tool spec that delegates to another agent through the orchestration layer. Checks `DelegationContext` (depth, circular visited set) before calling `subagentRuntime.spawn / send` or, when `background: true`, a `backgroundManager`. Only middleware with `propagate: true` is inherited.
- **BackgroundOutputTool / BackgroundCancelTool** — companions to the background path. Fetch or cancel results by `task_id`.
- **McpClient** — wraps the MCP SDK. Connects via stdio / SSE / streamable HTTP. `listTools()` / `callTool()` convert MCP tool specs and results to `Tool.Spec` / `Tool.Result`.

## KEY PATTERNS

- **Stateless core**: Every `ChatAgent.run()` is independent — no session mutation, no storage. State (budget, memory, delegation) lives on a per-call context.
- **Sink-driven**: Callers pass a `Sink` (from `@openomni/protocol`) to receive streaming output. The agent never creates sessions on its own.
- **Middleware > hooks**: New extensions MUST use `middleware: [...]`. Legacy `hooks` / `stepGuard` are routed through `compat.ts` purely for backward compatibility.
- **Budget check before each turn**: `checkBudget()` runs before `llmRun()`, not after, so budget enforcement blocks the next turn cleanly.
- **Delegation safety**: `DelegationContext` with `visitedAgents: Set<string>` and `maxDepth` prevents circular / runaway delegation.
- **Message format**: `ChatAgentInput.messages` is a simple `{ role: "user" | "assistant"; content: string }[]`. Richer `Message.WithParts[]` is used internally only.

## ANTI-PATTERNS

- Agent depends on `@openomni/session` for observability only (Log, Bus, Telemetry, TraceContext). Do NOT use session for state management — orchestration that needs session state lives in `@openomni/openomni`.
- Do NOT add new `ExecutionHooks` / `stepGuard` callers. Extend behavior via `middleware: [...]`.
- Do NOT mutate the legacy compat types — they exist only for backward compatibility and will be trimmed once downstream callers migrate.
- Do NOT bypass `ToolGuard.check` by returning placeholder tool results in user code; use a `pre_tool_use` middleware so behavior is uniform.
