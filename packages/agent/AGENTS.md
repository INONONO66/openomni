# packages/agent

`ChatAgent` — an invocation-scoped LLM + tool ReAct loop driven by a policy engine — plus the MCP client runtime. Depends on `@openomni/protocol`, `@openomni/policy`, `@openomni/placement` (the #752 pure model-fallback fold), and `@openomni/llm`. It reports through an injected `BusEvent.Sink` on `ChatAgentConfig.events`, so `src/` imports no implementation of the observation channel and reaches no durable storage — `check-deps.ts` carries a `srcAllowedDeps` for this package that rejects both (#606).

## STRUCTURE

```
src/
├── index.ts                    # Public API
├── core/
│   ├── chat-agent.ts           # ChatAgent.create() — provides run()
│   ├── types.ts                # ChatAgentConfig, ChatAgentInput, AgentResult (+ internal step/budget/usage; streaming Sink is llm-owned)
│   ├── budget.ts               # createBudgetState / checkBudget / recordTurn / recordToolCall / recordTokenUsage
│   ├── retry.ts                # DEFAULT_RETRY_POLICY, classifyRetryReason, shouldRetry, sleep
│   ├── message-factory.ts      # Message envelope helpers for injected messages
│   ├── execution/              # Agent loop: run/turn/tools/effects/state, lifecycle dispatch, and event projection
│   └── policy/
│       ├── index.ts            # Agent-scoped PolicyEngine facade over @openomni/policy
│       └── types.ts            # PolicyContext, canonical registration types, PolicyEngineRegistration
├── compaction/                 # compact/measure/reduce/speculate mechanisms + run.completion.pre policy adapter
└── runtime/
    └── mcp/                    # McpClient split across connection, transport, descriptor, conversion, and type modules
```

## PUBLIC API

```typescript
import { ChatAgent, PolicyEngine } from "@openomni/agent";

const agent = ChatAgent.create({
  model: { provider: "anthropic", id: "claude-haiku-4-5" },
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
// result.finishReason: 'stop' | 'max-steps' | 'stalled'
// result.text / result.steps / result.usage
```

Also exported from `@openomni/agent`:

- Types: `ChatAgentConfig`, `ChatAgentInput`, `AgentResult`
- Policy: `PolicyEngine`, `PolicyContext`, `PolicyFn`, `CanonicalPolicyRegistration`, `PolicyEngineRegistration`, `PolicyEngineInstance`, `PolicyRegistrationFactory`
- Budget queries: `checkBudget`, `describeBudgetRemaining`, `BudgetState` — the accounting stays here, what to say about it does not (D5)
- Reason codes: `RunReasonCode`; compaction: `createCompactionPolicy`, `isTimeCarriageMarkerPart`, `CompactionOptions`; runtime: `McpClient`

The entry carries what a consumer somewhere actually imports (#647). Types
reachable through exported signatures (`BudgetStatus`, `AgentStep`, `Sink`, …)
stay exported at their definition sites; a consumer that needs to *name* one
adds the one-line re-export in the same PR that imports it.

## ChatAgentConfig

| Field            | Type                                     | Description                                                                 |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `events`         | `BusEvent.Sink`                          | Required. Where the run's records go — the loop reports through this port and never reaches for `Bus` |
| `model`          | `Model.Ref`                              | Required LLM provider + model id                                            |
| `systemPrompt?`  | `string`                                 | Base system prompt                                                          |
| `tools?`         | `(Tool.Spec & { descriptor?: RuntimeResource.Descriptor })[]` | Tool specs plus optional structured policy provenance; descriptors survive catalog preparation and tool execution |
| `budget?`        | `AgentBudget`                            | Max turns / tool calls / wall time / tool runtime (use `-1` for unlimited)  |
| `toolExecutor?`  | `(call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>` | Custom tool executor; wrapped by `createToolExecutor` |
| `signal?`        | `AbortSignal`                            | External cancellation                                                       |
| `modelFallbacks?` | `Model.Ref[]`                           | Ordered fallback models after `model` (#752): a chain-advancing failure (timeout / transient_error / validation_error) moves the next retry attempt to the next candidate via the pure `@openomni/placement` fold; tool errors, context overflow (the compaction recovery retries the SAME model), and aborts never advance; a spent chain clamps to its last candidate — retry termination stays the retry policy's call. A configured chain also makes `validation_error` retryable (terminal without one); a model switch resets the model-scoped window guards (`windowYieldDisarmed`, the L5 overflow one-shot) and the `connection.llm.pre/post` context carries the model ACTUALLY called |
| `steeringPending?` | `() => boolean`                        | Mid-turn steering signal (#751): loop-native stop-condition port in the same class as `signal` and the window yield — a wake-up check the step loop reads at step boundaries, NEVER a judgment surface. The behavioral decision (what to inject, whether to continue) flows exclusively through the `run.turn.post` policy point; the policy plane cannot evaluate inside the llm step loop by ring design (llm imports no policy engine), so a signal port is the only honest shape |
| `middleware?`    | `PolicyEngineRegistration[]`             | Caller-owned canonical point registrations; legacy timing shapes are REJECTED fail-closed at registration (#530, typed `legacy_timing_registration`) |
| `providerOptions?` | `Record<string, unknown>`              | Forwarded to the underlying provider SDK                                    |

## POLICY ENGINE

The policy engine is the extension surface. `@openomni/agent` exposes an agent-scoped `PolicyEngine` facade over the generic engine in `@openomni/policy`; the facade binds the full agent `PolicyContext`; legacy timing registrations are rejected fail-closed at the boundary (#530). Agent execution dispatches through the registered policy points defined in `@openomni/protocol` `policy/policy-point.ts`:

```
run.lifecycle.pre → run.turn.pre → prompt.context.pre → tool.catalog.pre
        → connection.llm.pre → connection.llm.post
        → tool.native.pre / tool.mcp.pre → tool.native.post / tool.mcp.post
        → run.turn.post → run.completion.pre → run.lifecycle.post → run.error.error
```

- **Registration**: use `CanonicalPolicyRegistration { kind: "point", name, pointIds, effectCapabilities, priority, scope?, failPolicy?, fn }`. `pointIds` declares where the policy may run and `effectCapabilities` declares the effects it may return at each point. Lower `priority` runs first; `scope.agentType` optionally filters by agent kind; omitted `failPolicy` follows each protocol point contract. `PolicyEngineRegistration` IS the canonical shape — the old timing-based form throws a typed `legacy_timing_registration` error at `register()` (#530); there is no compatibility path.
- **Decision** (`Policy.PolicyDecision`): `allow | deny | pending`, with effects such as `prompt.inject_message`, `prompt.replace`, `tool.rewrite_input`, `run.replace_messages`, and `writeback.rewrite`.
- **System prompt effects**: `dispatchPoint("prompt.context.pre", ...)` returns canonical prompt effects; composition happens through effect merging rather than legacy verdict transforms.
- **Ownership**: `ChatAgent` registers only caller-supplied `middleware`; runtime builders own default policy assembly (budget, tool permission, compaction) and, per D5, increasingly the policies themselves.
- **Builtins** — all supplied by `openomni` since #642; the core package owns no default policy assembly. Stamped plans from the dispatch gate (#479) reference these ids:
  - `builtin:compaction` — mechanism here (`src/compaction/compact.ts` + the `run.completion.pre` seam adapter `src/compaction/policy.ts`); registered by `openomni`'s `registerCompaction`, which supplies the strategy config and the ordering priority
  A `required: true` plan entry whose id is not registered fails closed at middleware build (the worker run fails rather than silently skipping the policy).
  - Moved out (#625): `builtin:idle-nudge` — `openomni`'s `execution-runtime/middleware/idle-nudge-policy.ts`, registered by `registerIdleNudge`
  - Moved out (#629): `builtin:tool-permission` — `openomni`'s `execution-runtime/middleware/tool-permission-policy.ts`, registered by `registerToolPermission(registry, events)`. The executor still resolves the canonical policy name and the tool's labels; matching a ruleset against them is the policy's
  - Moved out (#626): `builtin:budget-reassurance` / `builtin:budget-warning` — `openomni`'s `execution-runtime/middleware/budget-nudge-policy.ts`, registered by `registerBudgetNudges`. Budget *accounting* stays here; `checkBudget` and `describeBudgetRemaining` are exported so the product can decide what to say about what is left

## TURN LIFECYCLE (core/execution)

```
run.ts (entry) → Promise<AgentResult>
  ├─ retry loop (maxAttempts)
  ├─ build PolicyEngine once (config.middleware only)
  │
  │   ├─ dispatchPoint(run.lifecycle.pre)       → allow (with effects) / deny
  │   └─ turn loop (while budget ok)
  │       ├─ checkBudget → if exceeded, dispatchPoint(run.lifecycle.post) + return result
  │       ├─ dispatchPoint(run.turn.pre)        → budget nudges, idle-nudge (both openomni)
  │       ├─ dispatchPoint(prompt.context.pre)  → context/prompt enrichment
  │       ├─ dispatchPoint(tool.catalog.pre)    → filter/modify tools exposed to LLM
  │       ├─ dispatchPoint(connection.llm.pre)
  │       ├─ llmRun via @openomni/llm (nested transport retries disabled)
  │       ├─ dispatchPoint(connection.llm.post)
  │       │    └─ tool calls flow through tools.ts:
  │       │         ├─ dispatchPoint(tool.native.pre / tool.mcp.pre)  → tool-permission (fail-closed)
  │       │         ├─ execute tool
  │       │         └─ dispatchPoint(tool.native.post / tool.mcp.post) → idle-nudge reset, enrichment
  │       ├─ outcome === "stop"?
  │       │    ├─ dispatchPoint(run.turn.post)  → allow (with continuation effects) / deny
  │       │    ├─ if continuation: dispatchPoint(run.completion.pre) → loop
  │       │    └─ else: dispatchPoint(run.lifecycle.post) + return result
  │       └─ outcome === "error"/"aborted"?
  │            └─ dispatchPoint(run.error.error) → retry (shouldRetry) or throw
```

## OWNERSHIP BOUNDARY

Allowed here:

- Invocation-scoped `ChatAgent` execution and streaming.
- Agent-scoped `PolicyEngine` facade and canonical point dispatch over the generic policy primitive.
- Generic tool invocation contracts and tool executor wrapping.
- Generic MCP client primitives when no server/OpenOmni product behavior is embedded.

Not allowed here:

- Creating, resolving, or mutating OpenOmni sessions for product orchestration.
- Choosing whether a message targets Resident, Worker, external actor, schedule, or surface.
- Looking up `PendingAskStore`, `PendingInteractionStore`, `SurfaceKey`, `ChannelGrantStore`, or `BlacklistStore` for routing.
- Encoding OpenOmni actor trust, channel grants, or external-response lifecycle rules.
- Persisting durable background task state or owning orchestration/scheduling; those are OpenOmni/ledger and host responsibilities.
- Owning channel-specific or server-specific MCP/tool wiring.

When in doubt, keep the agent package as a loop engine and put product semantics in `apps/openomni`.

## RUNTIME PRIMITIVES

- **McpClient** — wraps the MCP SDK. Connects via stdio / SSE / streamable HTTP. `listTools()` / `callTool()` convert MCP tool specs and results to `Tool.Spec` / `Tool.Result`.

## KEY PATTERNS

- **Invocation-scoped core**: Every `ChatAgent.run()` is independent — no session mutation, storage, durable orchestration, or scheduler. Per-run state such as budget and memory lives on the call context. For future replayable WorkItem attempts, the host supplies captured nondeterministic inputs; this package does not discover or persist them. The normative attempt contract lives in the [kernel contract](../../docs/kernel-contract.md).
- **Sink-driven**: Callers pass the `Sink` owned by `@openomni/llm` to receive streaming output. The agent never creates sessions on its own.
- **Policy > ad-hoc hooks**: New extensions MUST use canonical point registrations in `middleware: [...]`. `PolicyEngine.create()` is the single extension surface; timing registrations are rejected fail-closed (#530).
- **Budget check before each turn**: `checkBudget()` runs before `llmRun()`, not after, so budget enforcement blocks the next turn cleanly.
- **Retry ownership**: One Agent attempt makes one provider call: its `RunInput` sets `maxRetryAttempts: 0`, disabling `llm.run`'s nested transport retries for this orchestrated path. Agent owns inter-attempt classification, backoff, `maxAttempts`, and fallback selection; standalone `llm.run` callers retain bounded transport retry. A retried Agent attempt is the same turn: `recordRunTurn` charges once per `turnIndex`, while tokens and tool calls still charge per attempt because they were spent.
- **Message format**: `ChatAgentInput.messages` is a simple `{ role: "user" | "assistant"; content: string }[]`. Richer `Message.WithParts[]` is used internally only.

## ANTI-PATTERNS

- Reaching for `@openomni/ledger` or `@openomni/telemetry` from `src/`. The loop owns no durable state and does not choose where its records go: it reports through `config.events`, and orchestration that needs session state lives in the product app. `srcAllowedDeps` rejects both, so this fails the gate rather than review.
- Do NOT extend behavior outside `middleware: [...]`. `PolicyEngine` is the single extension surface.
- Do NOT bypass the policy engine by returning placeholder tool results in user code; use a `tool.native.pre` / `tool.mcp.pre` policy so behavior is uniform.
- Do NOT add OpenOmni communication kernel logic here. No actor authority, PendingInteraction routing, channel grants, worker grants, SurfaceKey routing, or writeback decisions.
