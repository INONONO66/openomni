# Ingress Module

Current inbound stage for the OpenOmni communication kernel. Ingress bridges resolved inbound events to session projection and execution. It is not the long-term owner of all communication semantics; inbound routing converges on the single kernel `resolveRoute` pipeline (#464: blacklist → wait correlation → ceiling → actor → surface), and this module's scattered decision sites are consolidation targets, not extension points.

## Pipeline

The current inbound stage flows through three stages:

1. **Session resolution** (`session-resolver.ts`) — maps surface+workspace+channel to a session via `SurfaceKey` registry. Creates new sessions on first contact; reuses existing ones on repeat.
2. **Event projection** (`event-projector.ts`) — converts the `InboundEvent` into a `UserMessage` + `TextPart` and persists both to the resolved session.
3. **Mode dispatch** (`handlers.ts`) — routes direct events to the execution handler:

| Mode | Handler | What it does | Policy |
| --- | --- | --- | --- |
| `direct` | `handleDirect` | Builds message array, runs a single `ChatAgent` | Primary path |

External and internal incoming events currently route through Ingress. Runtime-to-runtime/system egress commands currently use Dispatch; cron fire remains `IngressEngine.ingestInternal()`. Treat Ingress and Dispatch as kernel implementation stages, not separate product layers.

## Boundary Rules

- Do not add server/channel-specific logic here. Raw transport normalization belongs in `apps/server`; product communication decisions belong in OpenOmni kernel code.
- Do not query or mutate pending stores from server bridge code to pre-classify inbound messages. PendingInteraction/PendingAsk correlation precedence belongs in the kernel routing pipeline (#464).
- Avoid recomputing targets across helpers. Resolve target/session once in the kernel stage and pass the resolved facts through context.
- Keep `mode: "direct"` as a compatibility/validation fact unless a real new execution mode is introduced. Do not add mode branches as a substitute for communication routing.
- Writeback and projection policy belongs in OpenOmni, but low-level message persistence still goes through `@openomni/session`.

## Session Bridge

`session-bridge.ts` reads session messages into a flat `{ role, content }` array for `ChatAgent.run()`.


## Dependencies

- **Upstream**: `@openomni/protocol` (schemas), `@openomni/session` (storage), `@openomni/agent` (ChatAgent)
- **Downstream**: consumed by `apps/server` (per-message `createMessageHandler` -> `IngressEngine.ingest`) and internal OpenOmni kernel stages that submit resolved inbound events
