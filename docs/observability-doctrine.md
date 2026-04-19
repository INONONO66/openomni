# Observability Doctrine

Three distinct channels carry observability data in OpenOmni: `Log`, `Bus`, and `Telemetry`. Each serves a different consumer and a different purpose. Mixing them creates noise, missed signals, and wasted compute.

## When to Use Log

`Log` (`packages/session/src/log/index.ts`) writes newline-delimited JSON to stdout. It's for humans: operators reading logs, developers debugging, alerting pipelines scanning for error patterns.

Use `Log` when the audience is a person or a log aggregator, not another module in the process.

```typescript
import { Log } from "@openomni/session";

// operator needs to know a run started
Log.info("run started", { sessionId, runId, model: config.model.id });

// something broke and needs attention
Log.error("LLM request failed", { sessionId, attempt, error: err.message });

// unexpected but we handled it
Log.warn("retry triggered", { sessionId, attempt, maxAttempts });

// detailed diagnostic, only visible when OPENOMNI_LOG_LEVEL=debug
Log.debug("middleware verdict", { timing, action, reason });
```

The `OPENOMNI_LOG_LEVEL` env var controls the minimum level (default: `info`). Debug calls are filtered at the `write()` level before any string interpolation, so they're zero-cost when disabled.

**Do not use `Log` for:**
- State transitions that other modules need to react to (use `Bus.publish()`)
- Performance timing across service boundaries (use `Telemetry.span()`)
- Anything that will be consumed programmatically within the process

## When to Use Event

`Bus` (`packages/session/src/bus/index.ts`) is an in-process pub/sub channel. Events are typed and dispatched via `queueMicrotask` so handlers don't block the publisher. Nothing is persisted by default.

Use `Bus.publish()` when a state transition needs to be observed by other modules in the same process, without creating a direct dependency between them.

```typescript
import { Bus } from "@openomni/session";
import { AgentExecution } from "@openomni/protocol";

// a turn started — the session layer, metrics collector, and UI bridge
// can all subscribe without the agent knowing about any of them
Bus.publish(AgentExecution.TurnStart, {
  sessionId,
  agentId,
  turnIndex,
  time: Date.now(),
});

// subagent lifecycle — BackgroundManager publishes, coordinator subscribes
Bus.publish(Subagent.Events.WorkerRunStarted, {
  traceId,
  payload: { sessionId, runId, title },
  time: Date.now(),
});
```

Bus event schemas are defined with `BusEvent.define()` across protocol and session: `packages/protocol/src/event/`, `packages/protocol/src/subagent/index.ts`, `packages/session/src/session/index.ts`, and `packages/session/src/snapshot/index.ts`. New events follow this pattern:

```typescript
export const MyEvent = BusEvent.define(
  "my.event.name",
  z.object({ sessionId: z.string(), time: z.number() }),
);
```

**Do not use `Bus` for:**
- Human-readable diagnostics (use `Log`)
- Cross-process communication (use IPC transport in `packages/coordinator/src/ipc/`)
- Durable event storage (use `EventLog` in `packages/session/src/event-log/`)

### Relationship to `eventEmitter`

`ChatAgentConfig.eventEmitter` (`packages/agent/src/core/types.ts`) is a separate callback interface for streaming agent events to the caller:

```typescript
interface AgentEventEmitter {
  emit(eventName: string, data: Record<string, unknown>): void;
}
```

It carries `AgentEvent` variants (`text_chunk`, `tool_call_start`, `turn_complete`, etc.) and is wired by the caller, not the agent. `Bus.publish()` is for cross-module coordination inside the process. `eventEmitter` is for the caller's streaming UI or test harness. They're complementary: the agent emits both, for different audiences.

## When to Use Span

`Telemetry` (`packages/session/src/telemetry/index.ts`) wraps the OpenTelemetry API. Spans capture timing with parent-child relationships across async boundaries. Counters and histograms track aggregate metrics.

Telemetry is **disabled by default**. `Telemetry.init({ enabled: false })` is the default state. Spans fall through to a no-op when disabled, so call sites pay no runtime cost.

```typescript
import { Telemetry } from "@openomni/session";

// wrap an LLM call to measure latency and capture model attributes
const result = await Telemetry.span(
  "llm.request",
  async (span) => {
    span.setAttribute("model.id", config.model.id);
    span.setAttribute("model.provider", config.model.provider);
    return fetchCompletion(messages);
  },
  { "session.id": sessionId },
);

// count tool invocations for aggregate metrics
const toolCounter = Telemetry.counter("agent.tool.invocations");
toolCounter.add(1, { tool: toolName });
```

Use `Telemetry.span()` when:
- You need timing with parent-child relationships (LLM call inside a turn inside a run)
- The operation crosses a meaningful async boundary
- You want the data in an OTel-compatible backend (Jaeger, Honeycomb, Datadog)

**Do not use `Telemetry` for:**
- Logging human-readable messages (use `Log`)
- Triggering reactions in other modules (use `Bus`)
- Anything that must work without OTel SDK configuration

## Log Levels

| Level | When to use | Examples |
|-------|-------------|---------|
| `error` | Something broke and requires operator attention. The system cannot recover without intervention. | LLM request failed after all retries, storage write failed, tool executor threw an unhandled exception |
| `warn` | Unexpected condition, but the system handled it. Worth knowing, not worth waking someone up. | Retry triggered for transient error, budget threshold crossed, compaction fallback used |
| `info` | Significant lifecycle event. Useful for tracing what happened in a run without debug noise. | Run started, turn completed, session created, subagent spawned |
| `debug` | Detailed diagnostic. Only useful when actively investigating a specific problem. | Middleware verdict and reason, token count per turn, message hash for dedup check, tool permission check result |

`debug` is the only level where lazy evaluation matters. If constructing the log context is expensive, guard it:

```typescript
// fine for cheap context
Log.debug("tool permission check", { toolName, allowed });

// guard expensive serialization
if (process.env.OPENOMNI_LOG_LEVEL === "debug") {
  Log.debug("full message history", { messages: serializeMessages(history) });
}
```

## Sensitive Data Policy

The log stream is the most likely channel to leak sensitive data. Treat it as potentially visible to anyone with log access.

**Never log:**
- API keys, OAuth tokens, or any credential material
- Full message content (user prompts, assistant responses, tool inputs/outputs)
- User PII (names, emails, identifiers from external systems)
- Tool input or output bodies (log the tool name and call ID, not the payload)

**Safe to log:**
- Token counts (`inputTokens`, `outputTokens`)
- Model IDs and provider names
- Tool names (not arguments)
- Session IDs, run IDs, trace IDs
- Timing values (elapsed ms, timestamps)
- Error codes and error messages (not stack traces with embedded data)
- Status transitions (`queued`, `running`, `completed`)

The same policy applies to Bus event payloads. `AgentExecution.ToolInvoked` carries `inputSummary` (a short string), not the full input. If you're adding a new event schema in `packages/protocol/src/event/`, keep payloads to identifiers and summaries.

Telemetry span attributes follow the same rules. Span attributes end up in external backends. Never set a span attribute to a full message body or credential.

## TraceContext Propagation

A trace context ties together all the log lines, bus events, and spans that belong to a single request. The `traceId` field in `Subagent.Events.BaseEvent` (`packages/protocol/src/subagent/index.ts`) is the current anchor point.

**Creation:** A trace context is created once at the ingress entry point, before any session resolution or agent dispatch. Every log line and event emitted during that request carries the same `traceId`.

**Threading:** Trace context is passed explicitly through function parameters. OpenOmni does not use `AsyncLocalStorage` for trace propagation. If a function needs to log with trace context, it receives the context as an argument.

```typescript
// ingress creates the context
const traceId = crypto.randomUUID();

// threaded explicitly into downstream calls
await handleDirect(event, { traceId, sessionId });

// subagent spawn carries the same traceId
Bus.publish(Subagent.Events.WorkerRunStarted, {
  traceId,
  payload: { sessionId, runId, title },
  time: Date.now(),
});
```

**Auto-generation:** Call sites that don't have an ingress context (tests, CLI commands, direct API calls) generate a fresh `traceId` locally. This ensures every log line has a trace ID without requiring callers to thread context manually.

**Parent-child chains:** When a subagent spawns a child, the child inherits the parent's `traceId`. The `runId` and `taskId` fields distinguish the child's work within the same trace. This means a single `traceId` can span multiple sessions and multiple worker runs in a multi-agent execution.

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `traceId` | Yes | UUID, created at ingress, shared across the entire request tree |
| `sessionId` | No | The session this work belongs to |
| `runId` | No | The specific worker run within a session |
| `taskId` | No | The background task ID, if this is a fire-and-forget execution |
| `agentName` | No | The agent profile name handling this work |

When adding new bus events or log calls, include `traceId` in the context whenever it's available. It's the primary key for correlating observability data across the system.
