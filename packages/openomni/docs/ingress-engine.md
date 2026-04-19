# INGRESS ENGINE

| API | Signature |
| --- | --- |
| `IngressEngine.reset` | `reset(): void` — clears `SurfaceKey` + `Session` state (test-only) |
| `IngressEngine.ingest` | `ingest(event: InboundEvent): Promise<IngressResult>` |

### Architecture

`IngressEngine.ingest(event)` is a **stateless pipeline** that validates, resolves sessions, projects events, and routes to the appropriate handler based on `event.mode`.

```
InboundEvent
  └─→ IngressEngine.ingest()
        ├─→ InboundEventSchema.parse()              — Zod validation (original event is preserved so function fields survive)
        ├─→ IngressSessionResolver.resolve()         — SurfaceKey-based session lookup/create
        ├─→ IngressEventProjector.project()          — persist UserMessage + TextPart to the session
        └─→ switch (event.mode)
              ├─→ "plan"   → IngressHandlers.handlePlan()   → coordinator.dispatch() → runPlan()
              └─→ "direct" → IngressHandlers.handleDirect() → coordinator.dispatch() → ChatAgent.run()
```

Only `plan` and `direct` modes exist. Parallel execution across plan steps is the caller's responsibility (typically through `SubagentRuntime` / `BackgroundManager`).

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
// Discriminated union by mode
type InboundEvent =
  | {
      mode: "plan";
      id: string;
      surface: string;
      workspace?: string;
      channel?: string;
      userId?: string;
      payload: unknown;
      meta?: Record<string, unknown>;
      agent: AgentDef;
    }
  | {
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
  model: { provider: string; id: string };
  systemPrompt?: string;
  tools?: Tool.Spec[];
  budget?: { maxTurns?: number };
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>; // TS-only — not part of the Zod schema
};
```

### IngressResult (from `@openomni/protocol`)

```typescript
type IngressResult =
  | { mode: "plan";   sessionId: string; result: { planId: string } }
  | { mode: "direct"; sessionId: string; result: { output: string; finishReason: string } };
```

### Session Lifecycle

A single session spans plan → re-plan → direct interactions:

- Same `surface` + `workspace` + `channel` → same session via `SurfaceKey`.
- Re-plan: a second `mode: "plan"` call on the same session reads the previous plan from `Storage.PlanSubAdapter` (via `__OPENOMNI_PLANID__` marker) and combines with new user feedback.
- Direct follow-up: `mode: "direct"` reads the flat session history and runs a single `ChatAgent`.

### Key Modules

| Module | File | Responsibility |
| --- | --- | --- |
| `IngressEngine` | `src/ingress/engine.ts` | Top-level stateless pipeline |
| `IngressSessionResolver` | `src/ingress/session-resolver.ts` | SurfaceKey → session lookup/create |
| `IngressEventProjector` | `src/ingress/event-projector.ts` | InboundEvent → UserMessage + TextPart |
| `SessionBridge` | `src/ingress/session-bridge.ts` | Session ↔ agent input/output conversion (plan ID markers + `Storage.PlanSubAdapter` reads) |
| `IngressHandlers` | `src/ingress/handlers.ts` | Mode-specific handler functions |

### Architectural Decisions

- **Stateless** — no `configure()`; all info comes from `InboundEvent`. Agent definitions are provided by the caller (e.g. `apps/server` builds them from its own agent registry).
- **`toolExecutor` preserved** — the Zod parse is validation-only; the original event object is used downstream so function fields such as `toolExecutor` survive.
- **Plan stored in Storage** — plans are persisted in `Storage.PlanSubAdapter`. The session stores only a `planId` reference (via `__OPENOMNI_PLANID__` marker) so `SessionBridge` can locate the plan for re-planning.
- **Re-plan via conversation** — there is no dedicated re-plan API. Session history provides the context for the next `plan` call.
- **No auto mode** — mode selection is explicit. `apps/server` uses a `/plan` text prefix to detect plan mode before calling `IngressEngine.ingest`.
- **No rework** — post-execution result modification is out of scope.
