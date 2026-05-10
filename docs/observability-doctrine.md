# Observability Doctrine

`Bus` is the single observability layer in OpenOmni. All behavior flows through `Bus.publish()`, gets captured by the `BusPersistence` observer, and lands in the `bus_event` table. There's no separate log module, no telemetry pipeline, no event log bridge. One channel, one storage path, one query API.

## Bus as Universal Layer

Every module that needs to signal state publishes a typed event through `Bus.publish()`. The `BusPersistence` observer (`packages/session/src/bus-persistence/`) watches the bus and automatically persists non-ephemeral events to the database.

```typescript
import { Bus } from "@openomni/session";
import { AgentExecution } from "@openomni/protocol";

// a turn started — session layer, UI bridge, and any other subscriber
// can react without the agent knowing about any of them
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

**Ephemeral events** are skipped by `BusPersistence`. Mark an event ephemeral when it's only useful in-process and has no value in the historical record:

```typescript
export const MyEphemeralEvent = BusEvent.define(
  "my.ephemeral.event",
  z.object({ sessionId: z.string(), time: z.number() }),
  { visibility: "ephemeral" },
);
```

**Do not use `Bus` for:**
- Cross-process communication (use IPC transport in `packages/coordinator/src/ipc/`)

### BusPersistence Observer

`BusPersistence.start()` registers a global observer on the bus. It runs two things for every event:

1. **Stdout output** for operational events (see next section).
2. **DB persistence** for all non-ephemeral events, serialized as JSON into the `bus_event` table.

The observer chains writes per session ID to preserve ordering without blocking the publisher. If a write fails, it logs a warning and continues; the bus itself is never blocked.

```typescript
import { BusPersistence } from "@openomni/session";

// call once at startup, before any agents run
const stop = BusPersistence.start();

// call on shutdown
stop();
```

`BusPersistence` requires a SQLite-backed storage adapter. It reads the active adapter from `Storage.getAdapter()` and writes directly to the `bus_event` table.

### Relationship to `eventEmitter`

`ChatAgentConfig.eventEmitter` (`packages/agent/src/core/types.ts`) is a separate callback interface for streaming agent events to the caller:

```typescript
interface AgentEventEmitter {
  emit(eventName: string, data: Record<string, unknown>): void;
}
```

It carries `AgentEvent` variants (`text_chunk`, `tool_call_start`, `turn_complete`, etc.) and is wired by the caller, not the agent. `Bus.publish()` is for cross-module coordination inside the process. `eventEmitter` is for the caller's streaming UI or test harness. They're complementary: the agent emits both, for different audiences.

## Operational Events

`Operational.*` events (`packages/protocol/src/event/operational.ts`) replace the old `Log` module. They're regular bus events with a structured payload, and `BusPersistence` writes them to stdout as newline-delimited JSON.

```typescript
import { Bus } from "@openomni/session";
import { Operational } from "@openomni/protocol";

// operator needs to know a run started
Bus.publish(Operational.Info, {
  traceId,
  time: Date.now(),
  component: "agent-runtime",
  msg: "run started",
  sessionId,
  context: { runId, model: config.model.id },
});

// something broke and needs attention
Bus.publish(Operational.Error, {
  traceId,
  time: Date.now(),
  component: "llm-provider",
  msg: "LLM request failed",
  sessionId,
  error: err.message,
  context: { attempt },
});

// unexpected but handled
Bus.publish(Operational.Warn, {
  traceId,
  time: Date.now(),
  component: "agent-runtime",
  msg: "retry triggered",
  sessionId,
  context: { attempt, maxAttempts },
});

// detailed diagnostic, only visible when OPENOMNI_LOG_LEVEL=debug
Bus.publish(Operational.Debug, {
  traceId,
  time: Date.now(),
  component: "middleware",
  msg: "middleware verdict",
  context: { timing, action, reason },
});
```

The `OPENOMNI_LOG_LEVEL` env var controls the minimum level (default: `info`). Debug events are filtered before stdout output, so they're zero-cost when disabled.

### Operational Event Schemas

All four log-level events share a common base:

| Field | Required | Description |
|-------|----------|-------------|
| `traceId` | Yes | Trace ID for correlation |
| `time` | Yes | Unix timestamp in ms |
| `component` | Yes | Module or subsystem name |
| `msg` | Yes | Human-readable message |
| `sessionId` | No | Session this event belongs to |
| `context` | No | Arbitrary key-value context |

`Operational.Error` adds an optional `error` field for the error message string.

Beyond the four log levels, `Operational.*` also includes lifecycle events:

| Event | When |
|-------|------|
| `Operational.BootstrapCompleted` | Server finished startup |
| `Operational.ShutdownInitiated` | Graceful shutdown started |
| `Operational.RecoveryStarted` | Crash recovery scan began |
| `Operational.RecoveryCompleted` | Crash recovery finished |

### Log Levels

| Level | When to use | Examples |
|-------|-------------|---------|
| `error` | Something broke and requires operator attention. The system can't recover without intervention. | LLM request failed after all retries, storage write failed, tool executor threw an unhandled exception |
| `warn` | Unexpected condition, but the system handled it. Worth knowing, not worth waking someone up. | Retry triggered for transient error, budget threshold crossed, compaction fallback used |
| `info` | Significant lifecycle event. Useful for tracing what happened in a run without debug noise. | Run started, turn completed, session created, subagent spawned |
| `debug` | Detailed diagnostic. Only useful when actively investigating a specific problem. | Middleware verdict and reason, token count per turn, message hash for dedup check, tool permission check result |

`debug` is the only level where lazy evaluation matters. If constructing the context is expensive, guard it:

```typescript
// fine for cheap context
Bus.publish(Operational.Debug, { traceId, time: Date.now(), component, msg: "tool permission check", context: { toolName, allowed } });

// guard expensive serialization
if (process.env.OPENOMNI_LOG_LEVEL === "debug") {
  Bus.publish(Operational.Debug, {
    traceId,
    time: Date.now(),
    component,
    msg: "full message history",
    context: { messages: serializeMessages(history) },
  });
}
```

## Query API

All persisted events are queryable through the `BusQuery` namespace (`packages/session/src/bus-persistence/query.ts`).

```typescript
import { BusQuery } from "@openomni/session";

// all events for a session, optionally filtered
const events = await BusQuery.listBySession(sessionId, {
  category: "agent",
  after: startTime,
  limit: 100,
});

// all events for a specific worker run
const runEvents = await BusQuery.listByRun(runId);

// only error events for a session
const errors = await BusQuery.listErrors(sessionId);

// aggregate counts by category and type
const stats = await BusQuery.getStats(sessionId);

// worker run history with event summaries
const history = await BusQuery.getWorkerRunHistory(sessionId);
```

### EventRecord Shape

| Field | Description |
|-------|-------------|
| `id` | Unique record ID |
| `sessionId` | Session this event belongs to |
| `runId` | Worker run ID, if applicable |
| `eventType` | Event type name (e.g., `agent.execution.started`) |
| `category` | One of `agent`, `operational`, `system`, `custom` |
| `data` | Full event payload |
| `traceId` | Trace ID for correlation |
| `durationMs` | Duration in ms, if the event carries it |
| `timeCreated` | Unix timestamp in ms |

### QueryOptions

| Field | Description |
|-------|-------------|
| `type` | Filter by exact event type name |
| `category` | Filter by category |
| `after` | Only events after this timestamp |
| `before` | Only events before this timestamp |
| `limit` | Maximum results to return |

## Sensitive Data Policy

The observability stream is the most likely channel to leak sensitive data. Treat it as potentially visible to anyone with log or database access.

**Never publish:**
- API keys, OAuth tokens, or any credential material
- Full message content (user prompts, assistant responses, tool inputs/outputs)
- User PII (names, emails, identifiers from external systems)
- Tool input or output bodies (publish the tool name and call ID, not the payload)

**Safe to publish:**
- Token counts (`inputTokens`, `outputTokens`)
- Model IDs and provider names
- Tool names (not arguments)
- Session IDs, run IDs, trace IDs
- Timing values (elapsed ms, timestamps)
- Error codes and error messages (not stack traces with embedded data)
- Status transitions (`queued`, `running`, `completed`)

The same policy applies to Bus event payloads. `AgentExecution.ToolInvoked` carries `inputSummary` (a short string), not the full input. If you're adding a new event schema in `packages/protocol/src/event/`, keep payloads to identifiers and summaries.

## TraceContext Propagation

A trace context ties together all the bus events that belong to a single request. The `traceId` field in `Subagent.Events.BaseEvent` (`packages/protocol/src/subagent/index.ts`) is the current anchor point.

**Creation:** A trace context is created once at the ingress entry point, before any session resolution or agent dispatch. Every event emitted during that request carries the same `traceId`.

**Threading:** Trace context is passed explicitly through function parameters. OpenOmni does not use `AsyncLocalStorage` for trace propagation. If a function needs to publish with trace context, it receives the context as an argument.

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

**Auto-generation:** Call sites that don't have an ingress context (tests, scripts, direct API calls) generate a fresh `traceId` locally. This ensures every event has a trace ID without requiring callers to thread context manually.

**Parent-child chains:** When a subagent spawns a child, the child inherits the parent's `traceId`. The `runId` and `taskId` fields distinguish the child's work within the same trace. This means a single `traceId` can span multiple sessions and multiple worker runs in a multi-agent execution.

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `traceId` | Yes | UUID, created at ingress, shared across the entire request tree |
| `sessionId` | No | The session this work belongs to |
| `runId` | No | The specific worker run within a session |
| `taskId` | No | The background task ID, if this is a fire-and-forget execution |
| `agentName` | No | The agent profile name handling this work |

When adding new bus events, include `traceId` in the payload whenever it's available. It's the primary key for correlating observability data across the system.

## Persona Workforce Observability

The persona workforce model adds a user-facing question that observability must answer: who assigned work to whom, where did it run, and what was written back to the original session?

Track these relationships with identifiers and summaries, not raw prompt bodies:

- original session ID;
- self-loop session ID, when work was forked;
- child persona session ID;
- persona or agent name;
- worker run ID;
- parent run ID, if available;
- writeback target session ID;
- result summary or memory candidate ID.

Do not publish full self-loop transcripts, drafts, social content bodies, user prompts, or private memory content. Store internal transcripts in session storage when required, and emit only correlation identifiers through Bus events.
