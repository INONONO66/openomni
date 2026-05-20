# INGRESS ENGINE

| API | Signature |
| --- | --- |
| `IngressEngine.reset` | `reset(): void` — clears `SurfaceKey` + `Session` state (test-only) |
| `IngressEngine.ingest` | `ingest(event: InboundEvent): Promise<IngressResult>` |

### Architecture

`IngressEngine.ingest(event)` is a **stateless pipeline** that validates, resolves sessions, projects events, and routes direct events to the coordinator.

```
InboundEvent
  └─→ IngressEngine.ingest()
        ├─→ InboundEventSchema.parse()              — Zod validation (original event is preserved so function fields survive)
        ├─→ IngressSessionResolver.resolve()         — SurfaceKey-based session lookup/create
        ├─→ IngressEventProjector.project()          — persist UserMessage + TextPart to the session
        └─→ IngressHandlers.handleDirect() → coordinator.dispatch() → ChatAgent.run()
```

Only `direct` mode exists. Delegated or asynchronous work is handled through `SubagentRuntime` / `BackgroundManager`.

### Controlled Inbound Authority

Ingress is the authority boundary for work entering the runtime.

- **External inbound**: user, surface, or API submits work to the Resident or a specific Worker.
- **Internal inbound**: the Resident or an explicitly trusted manager Worker submits new work back through ingress.
- **Ordinary Workers**: should return results or suggestions; they should not create new top-level inbound work by default.

This authority model is target direction, not the full current implementation. When implemented, inbound authority checks should happen before work is projected into durable session history.

### IngressEngine API

```typescript
namespace IngressEngine {
  // Test cleanup only — clears SurfaceKey + Session state
  function reset(): void;

  // Main entry point — fully stateless
  function ingest(event: InboundEvent): Promise<IngressResult>;
}
```

### InboundEvent Schema (from `@openomni/protocol`)

```typescript
type InboundEvent = {
  mode: "direct";
  id: string;
  surface: string;
  workspace?: string;
  channel?: string;
  userId?: string;
  payload: unknown;
  meta?: Record<string, unknown>;
  agent: AgentDef;
};

type AgentDef = {
  model: Model.Ref;
  systemPrompt?: string;
  tools?: Tool.Spec[];
  budget?: { maxTurns?: number };
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>; // TS-only — not part of the Zod schema
};
```

### IngressResult (from `@openomni/protocol`)

```typescript
type IngressResult = { mode: "direct"; sessionId: string; result: { output: string; finishReason: string } };
```

### Session Lifecycle

A single session spans direct interactions:

- Same `surface` + `workspace` + `channel` → same session via `SurfaceKey`.
- Direct follow-up: `mode: "direct"` reads the flat session history and runs a single `ChatAgent`.
- Future self-loop work should create child sessions instead of writing internal reasoning into the original user-facing session.

### Key Modules

| Module | File | Responsibility |
| --- | --- | --- |
| `IngressEngine` | `src/ingress/engine.ts` | Top-level stateless pipeline |
| `IngressSessionResolver` | `src/ingress/session-resolver.ts` | SurfaceKey → session lookup/create |
| `IngressEventProjector` | `src/ingress/event-projector.ts` | InboundEvent → UserMessage + TextPart |
| `SessionBridge` | `src/ingress/session-bridge.ts` | Session ↔ agent input/output conversion |
| `IngressHandlers` | `src/ingress/handlers.ts` | Mode-specific handler functions |

### Architectural Decisions

- **Stateless** — no `configure()`; all info comes from `InboundEvent`. Agent definitions are provided by the caller (e.g. `apps/server` builds them from its own agent registry).
- **`toolExecutor` preserved** — the Zod parse is validation-only; the original event object is used downstream so function fields such as `toolExecutor` survive.
- **Single mode** — inbound events use `mode: "direct"`; routing policy belongs in the caller before `IngressEngine.ingest`.
- **No rework** — post-execution result modification is out of scope.
