# Ingress Module

Single entry point that bridges inbound events to direct execution.

## Pipeline

Every inbound event flows through three stages:

1. **Session resolution** (`session-resolver.ts`) — maps surface+workspace+channel to a session via `SurfaceKey` registry. Creates new sessions on first contact; reuses existing ones on repeat.
2. **Event projection** (`event-projector.ts`) — converts the `InboundEvent` into a `UserMessage` + `TextPart` and persists both to the resolved session.
3. **Mode dispatch** (`handlers.ts`) — routes direct events to the execution handler:

| Mode | Handler | What it does | Policy |
| --- | --- | --- | --- |
| `direct` | `handleDirect` | Builds message array, runs a single `ChatAgent` | Primary path |

External and internal incoming events route through Ingress. Runtime-to-runtime/system egress commands use Dispatch instead; cron fire remains `IngressEngine.ingestInternal()`.

## Session Bridge

`session-bridge.ts` reads session messages into a flat `{ role, content }` array for `ChatAgent.run()`.


## Dependencies

- **Upstream**: `@openomni/protocol` (schemas), `@openomni/session` (storage), `@openomni/agent` (ChatAgent)
- **Downstream**: consumed by `apps/server` (per-message `createMessageHandler` → `IngressEngine.ingest`) and any surface adapter that submits `InboundEvent`s
