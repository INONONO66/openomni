# packages/agent

Pure ChatAgent primitive. Stateless LLM + Tool ReAct loop. No session dependency. Sink injected externally.

## STRUCTURE

```
src/
├── index.ts          # Public API: ChatAgent + types
├── chat-agent.ts     # ChatAgent namespace — create(), run(), stream() stub
├── types.ts          # ChatAgentConfig, ChatAgentInput, AgentResult, AgentStep, AgentBudget, TokenUsage
├── budget.ts         # Budget state tracking — createBudgetState, checkBudget, recordTurn, recordToolCall
└── retry.ts          # Retry logic — DEFAULT_RETRY_POLICY, calculateBackoffMs, classifyRetryReason, shouldRetry
```

## PUBLIC API

### ChatAgent.create(config: ChatAgentConfig): ChatAgentInstance

Creates a stateless ChatAgent instance.

```typescript
import { ChatAgent } from "@openomni/agent";

const agent = ChatAgent.create({
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  systemPrompt: "You are a helpful assistant.",
  tools: [],
  budget: { maxTurns: 10, maxToolCalls: 20 },
  onStepFinish: (step) => console.log("Step:", step.type),
});

const result = await agent.run({
  messages: [{ role: "user", content: "Hello!" }],
});
// result.finishReason: 'stop' | 'tool-calls' | 'max-steps' | 'handoff'
// result.text: string
// result.steps: AgentStep[]
```

### ChatAgentConfig

| Field        | Type                               | Required | Description               |
| ------------ | ---------------------------------- | -------- | ------------------------- |
| model        | `{ provider: string; id: string }` | YES      | LLM provider and model ID |
| systemPrompt | string                             | no       | System prompt             |
| tools        | Tool.Spec[]                        | no       | Available tools           |
| budget       | AgentBudget                        | no       | Execution budget limits   |
| onStepFinish | `(step: AgentStep) => void`        | no       | Step completion callback  |
| signal       | AbortSignal                        | no       | Cancellation signal       |

### ChatAgentInput

```typescript
interface ChatAgentInput {
  messages: Array<
    { role: "user"; content: string } | { role: "assistant"; content: string }
  >;
  metadata?: Record<string, unknown>;
}
```

### AgentResult

| Field        | Type                                                 | Description          |
| ------------ | ---------------------------------------------------- | -------------------- |
| text         | string                                               | Final assistant text |
| steps        | AgentStep[]                                          | All steps taken      |
| usage        | TokenUsage                                           | Token usage stats    |
| finishReason | `'stop' \| 'tool-calls' \| 'max-steps' \| 'handoff'` | Why agent stopped    |

### AgentBudget (all optional)

| Field            | Default | Description            |
| ---------------- | ------- | ---------------------- |
| maxTurns         | 24      | Max LLM turns          |
| maxToolCalls     | 40      | Max tool executions    |
| maxWallTimeMs    | 5 min   | Max wall clock time    |
| maxToolRuntimeMs | 2 min   | Max total tool runtime |

## KEY PATTERNS

- **Stateless**: No `@openomni/session` dependency. Each `run()` call is independent.
- **Sink injected externally**: Caller provides Sink for streaming output. No internal session creation.
- **stream() stub**: Phase 1 only — throws `'stream() not implemented yet (Phase 2)'`. Full implementation in Phase 2.
- **Budget check before each turn**: Budget is checked BEFORE calling LLM, not after.
- **Simple message format**: Input messages are `{ role: 'user' | 'assistant', content: string }[]` — NOT `Message.Info[]`.
- **Model resolution**: Uses `ModelsDev.get()` + `Provider.fromModelsDevModel()` from `@openomni/llm`.

## ANTI-PATTERNS

- Do NOT import `@openomni/session` — this package has zero session dependency.
- Do NOT use `stream()` in Phase 1 — it throws.
- For orchestration features (RunWorker, TaskManager, IngressEngine), use `@openomni/openomni` instead.
- Do NOT name new files `agent.ts` — it would collide with the existing `agent/` directory in legacy code.
