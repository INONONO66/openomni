# INGRESS ENGINE (Phase 3)

| API | Signature |
| --- | --- |
| `IngressEngine.reset` | `reset(): void` |
| `IngressEngine.ingest` | `ingest(event: InboundEvent): Promise<IngressResult>` |

### Architecture

`IngressEngine.ingest(event)` is a **stateless pipeline** that validates, resolves sessions, projects events, and routes to the appropriate agent based on mode.

```
InboundEvent
  └─→ IngressEngine.ingest()
        ├─→ InboundEventSchema.parse() — Zod validation (original event preserved)
        ├─→ IngressSessionResolver.resolve() — SurfaceKey-based session lookup/create
        ├─→ IngressEventProjector.project() — UserMessage + TextPart stored in session
        └─→ switch(event.mode):
              ├─→ "plan"   → IngressHandlers.handlePlan()   → PlanAgent.generate()
              ├─→ "team"   → IngressHandlers.handleTeam()   → TeamOrchestrator.execute()
              └─→ "direct" → IngressHandlers.handleDirect() → ChatAgent.run()
```

### IngressEngine API

```typescript
namespace IngressEngine {
  // Test cleanup only — clears SurfaceKey + Session state
  function reset(): void;

  // Main entry point — fully stateless
  async function ingest(event: InboundEvent): Promise<IngressResult>;
}
```

### InboundEvent Schema (from `@openomni/protocol`)

```typescript
// Discriminated union by mode
type InboundEvent =
  | { mode: "plan";   surface: string; workspace?: string; channel?: string; payload: unknown; agent: AgentDef }
  | { mode: "team";   surface: string; workspace?: string; channel?: string; payload: unknown; agents: { reviewer: AgentDef; executor: AgentDef } }
  | { mode: "direct"; surface: string; workspace?: string; channel?: string; payload: unknown; agent: AgentDef };

type AgentDef = {
  model: { provider: string; id: string };
  systemPrompt?: string;
  tools?: Tool.Spec[];
  budget?: { maxTurns?: number };
  toolExecutor?: (call: Tool.Call) => Promise<Tool.Result>; // TS-only, not in Zod schema
};
```

### IngressResult (from `@openomni/protocol`)

```typescript
type IngressResult =
  | { mode: "plan";   sessionId: string; result: PlanResult }
  | { mode: "team";   sessionId: string; result: TeamOrchestrator.TeamResult }
  | { mode: "direct"; sessionId: string; result: { output: string; finishReason: string } };
```

### Session Lifecycle

Single session spans the full plan→re-plan→execute lifecycle:
- Same `surface` + `workspace` + `channel` → same session (via SurfaceKey)
- Re-plan: second `mode: "plan"` call on same session includes previous Plan + user feedback in goal
- Team execution: `mode: "team"` extracts latest Plan from session, executes it

### Key Modules

| Module | File | Responsibility |
|--------|------|----------------|
| `IngressEngine` | `src/ingress/engine.ts` | Top-level stateless pipeline |
| `IngressSessionResolver` | `src/ingress/session-resolver.ts` | SurfaceKey → session lookup/create |
| `IngressEventProjector` | `src/ingress/event-projector.ts` | InboundEvent → UserMessage + TextPart |
| `SessionBridge` | `src/ingress/session-bridge.ts` | Session↔agent input/output conversion |
| `IngressHandlers` | `src/ingress/handlers.ts` | Mode-specific handler functions |

### Architectural Decisions

- **Stateless**: No `configure()` — all info comes from InboundEvent. Agent definitions provided by caller (CLI/CUI layer).
- **toolExecutor preserved**: Zod parse is validation-only; original event object used in pipeline to preserve function fields.
- **Plan stored in session**: As TextPart with `__OPENOMNI_PLAN__` prefix for extraction.
- **Re-plan via conversation**: No dedicated API — session history provides context for LLM re-generation.
- **No auto mode**: V1 requires explicit mode selection.
- **No rework**: Post-execution result modification is V2.
