# packages/agent

`ChatAgent` — a stateless LLM + tool ReAct loop driven by a policy engine — plus the multi-agent runtime (registry, subagent / background tools, MCP client). Depends on `@openomni/protocol`, `@openomni/llm`, and `@openomni/session` (for observability: Log, Bus, Telemetry, TraceContext).

## STRUCTURE

```
src/
├── index.ts                    # Public API
├── core/
│   ├── index.ts                # Core re-exports (ChatAgent, types, Memory)
│   ├── chat-agent.ts           # ChatAgent.create() — wraps streamAgent + provides run() / stream()
│   ├── types.ts                # ChatAgentConfig, ChatAgentInput, AgentResult, AgentStep, AgentEvent, AgentBudget, TokenUsage, Sink, legacy types
│   ├── budget.ts               # createBudgetState / checkBudget / recordTurn / recordToolCall / recordTokenUsage
│   ├── retry.ts                # DEFAULT_RETRY_POLICY, classifyRetryReason, shouldRetry, sleep
│   ├── delegation.ts           # DelegationContext + checkDelegation (depth / circular detection)
│   ├── memory.ts               # Memory interface + InMemoryMemory (Jaccard retrieval)
│   ├── runtime-context.ts      # Runtime context helpers for agent execution
│   ├── prompt-builder.ts       # System prompt composition helpers
│   ├── message-factory.ts      # Message envelope helpers for injected messages
│   ├── telemetry.ts            # Telemetry.span / counter / histogram (OpenTelemetry; disabled by default)
│   ├── execution/
│   │   ├── stream-engine.ts    # streamAgent() — retry loop + turn loop + policy dispatch
│   │   ├── tool-executor.ts    # Wraps user toolExecutor with invoke.prepare / invoke.result dispatch
│   │   └── compaction.ts       # InMemoryCompactor for message compression
│   └── policy/
│       ├── engine.ts           # PolicyEngine.create() — register, dispatch canonical PolicyDecision
│       ├── types.ts            # PolicyContext, PolicyFn, PolicyRegistration
│       └── builtin/
│           ├── budget.ts       # createBudgetReassurancePolicy / createBudgetWarningPolicy
│           ├── memory.ts       # createMemoryPolicy (context.prepare)
│           ├── compaction.ts   # createCompactionPolicy (completion.prepare)
│           ├── post-tool.ts    # createPostToolPolicy (invoke.result)
│           ├── post-turn.ts    # createPostTurnPolicy (turn.finish)
│           ├── idle-nudge.ts   # createIdleNudgePolicy (turn.start + invoke.result)
│           └── tool-permission.ts # createToolPermissionPolicy (invoke.prepare, fail-closed)
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

- Types: `ChatAgentConfig`, `ChatAgentInput`, `AgentResult`, `AgentStep`, `AgentEvent`, `AgentBudget`, `TokenUsage`, `Sink`, `AgentEventEmitter`
- Policy: `PolicyEngine`, `PolicyContext`, `PolicyFn`, `PolicyRegistration`, `PolicyEngineInstance`
- Runtime: `AgentRegistry`, `SubagentTool`, `SubagentToolOptions`, `BackgroundOutputTool`, `BackgroundCancelTool`, `McpClient`, `McpServerConfig`

## ChatAgentConfig

| Field            | Type                                     | Description                                                                 |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `model`          | `Model.Ref`                              | Required LLM provider + model id                                            |
| `systemPrompt?`  | `string`                                 | Base system prompt                                                          |
| `tools?`         | `Tool.Spec[]`                            | Tool specs available to the LLM                                             |
| `budget?`        | `AgentBudget`                            | Max turns / tool calls / wall time / tool runtime (use `-1` for unlimited)  |
| `toolExecutor?`  | `(call) => Promise<Tool.Result>`         | Custom tool executor; wrapped by `createToolExecutor`                       |
| `signal?`        | `AbortSignal`                            | External cancellation                                                       |
| `permissions?`   | `Policy.Permission`                      | Deprecated; ignored by ChatAgent core. Runtime builders must pass `createToolPermissionPolicy()` via `middleware` |
| `compaction?`    | `{ contextWindowTokens, ... }`           | Deprecated; ignored by ChatAgent core. Runtime builders must pass `createCompactionPolicy()` via `middleware` |
| `memory?`        | `Memory`                                 | Memory interface retrieved by the `memory` policy                           |
| `middleware?`    | `PolicyRegistration[]`                   | Caller-owned policy registrations                                           |
| `eventEmitter?`  | `AgentEventEmitter`                      | Optional event emitter for external observers                               |
| `providerOptions?` | `Record<string, unknown>`              | Forwarded to the underlying provider SDK                                    |

## POLICY ENGINE

The policy engine is the extension surface. Agent execution dispatches through the core `Policy.Timing` points defined in `@openomni/protocol`:

```
run.start → turn.start → context.prepare → resources.prepare
        → model.request → model.response
        → invoke.prepare → invoke.result
        → turn.finish → completion.prepare → run.finish → error
```

- **Registration**: `PolicyRegistration { name, timing, priority, scope?, failPolicy?, fn, propagate? }`. Lower `priority` runs first; `scope.agentType` optionally filters by agent kind; `failPolicy` is `fail-open` (default) or `fail-closed`.
- **Decision** (`Policy.PolicyDecision`): `allow | deny | pending`, with effects such as `prompt.inject_message`, `prompt.replace`, `tool.rewrite_input`, `run.replace_messages`, and `writeback.rewrite`.
- **System prompt effects**: `dispatch("context.prepare", ...)` returns canonical prompt effects; composition happens through effect merging rather than legacy verdict transforms.
- **Ownership**: `ChatAgent` registers only caller-supplied `middleware`; runtime builders own default policy assembly (budget, tool permission, compaction, idle nudge).
- **Builtins** (priority in parentheses):
  - `tool-permission` (0, fail-closed) — enforces `Policy.Permission` and `InputRule`; returns deny with `tool.skip_invocation` / `run.abort` / `tool.require_approval`
  - `budget-reassurance` (10) — injects a reassurance system message around 60% budget
  - `budget-warning` (20) — injects a warning around 80% budget
  - `memory` (100) — appends similar memory entries to the system prompt
  - `post-tool` (200) — user-supplied tool-output enricher
  - `post-turn` (250) — user-supplied post-turn judgement (continuation / abort)
  - `idle-nudge` (300) — detects idle ≥ threshold (default 60s), injects a nudge; after `maxNudges` (default 3) aborts with reason `stalled`
  - `compaction` (900) — triggers `InMemoryCompactor.compact()` when token threshold is exceeded

## TURN LIFECYCLE (StreamEngine)

```
streamAgent(input, config, sink) [AsyncGenerator<AgentEvent>]
  ├─ retry loop (maxAttempts)
  │   ├─ build PolicyEngine (config.middleware only)
  │   ├─ dispatch(run.start)                    → allow (with effects) / deny
  │   └─ turn loop (while budget ok)
  │       ├─ checkBudget → if exceeded, dispatch(run.finish) + yield complete
  │       ├─ dispatch(turn.start)               → budget warnings, idle-nudge
  │       ├─ dispatch(context.prepare)          → memory enrichment, identity
  │       ├─ dispatch(resources.prepare)        → filter/modify tools exposed to LLM
  │       ├─ dispatch(model.request)
  │       ├─ llmRun via @openomni/llm
  │       ├─ dispatch(model.response)
  │       │    └─ tool calls flow through createToolExecutor:
  │       │         ├─ dispatch(invoke.prepare)  → tool-permission (fail-closed)
  │       │         ├─ execute tool
  │       │         └─ dispatch(invoke.result) → idle-nudge reset, enrichment
  │       ├─ outcome === "stop"?
  │       │    ├─ dispatch(turn.finish)         → allow (with continuation effects) / deny
  │       │    ├─ if continuation: dispatch(completion.prepare) → loop
  │       │    └─ else: dispatch(run.finish) + yield complete
  │       └─ outcome === "error"/"aborted"?
  │            └─ dispatch(error) → retry (shouldRetry) or throw
```

## RUNTIME (MULTI-AGENT)

- **AgentRegistry** — global in-memory store of `AgentProfile.Definition` entries keyed by `name`. `define`, `get`, `has`, `list`, `override`, `clear`.
- **SubagentTool** — tool spec that delegates to another agent through the orchestration layer. Checks `DelegationContext` (depth, circular visited set) before calling `subagentRuntime.spawn / send` or, when `background: true`, a `backgroundManager`. Only middleware with `propagate: true` is inherited.
- **BackgroundOutputTool / BackgroundCancelTool** — companions to the background path. Fetch or cancel results by `task_id`.
- **McpClient** — wraps the MCP SDK. Connects via stdio / SSE / streamable HTTP. `listTools()` / `callTool()` convert MCP tool specs and results to `Tool.Spec` / `Tool.Result`.

## KEY PATTERNS

- **Stateless core**: Every `ChatAgent.run()` is independent — no session mutation, no storage. State (budget, memory, delegation) lives on a per-call context.
- **Sink-driven**: Callers pass a `Sink` (from `@openomni/protocol`) to receive streaming output. The agent never creates sessions on its own.
- **Policy > ad-hoc hooks**: New extensions MUST use `middleware: [...]`. `PolicyEngine.create()` is the single extension surface.
- **Budget check before each turn**: `checkBudget()` runs before `llmRun()`, not after, so budget enforcement blocks the next turn cleanly.
- **Delegation safety**: `DelegationContext` with `visitedAgents: Set<string>` and `maxDepth` prevents circular / runaway delegation.
- **Message format**: `ChatAgentInput.messages` is a simple `{ role: "user" | "assistant"; content: string }[]`. Richer `Message.WithParts[]` is used internally only.

## ANTI-PATTERNS

- Agent depends on `@openomni/session` for observability only (Log, Bus, Telemetry, TraceContext). Do NOT use session for state management — orchestration that needs session state lives in `@openomni/openomni`.
- Do NOT extend behavior outside `middleware: [...]`. `PolicyEngine` is the single extension surface.
- Do NOT bypass `Policy.evaluate()` by returning placeholder tool results in user code; use a `invoke.prepare` policy so behavior is uniform.
