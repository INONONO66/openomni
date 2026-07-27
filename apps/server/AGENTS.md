# apps/server

Hono/Bun runtime host that exposes OpenOmni through external channels (Discord / Telegram / GitHub / WebSocket), connector processes, MCP/custom tools, and worker entrypoints. The server owns transport and bootstrap, not product messaging/access semantics.

Inbound messages flow as raw channel payload → channel transport/auth/dedupe → normalized facts → OpenOmni messaging kernel → channel response. Server code must not decide Wait routing, session target, principal trust, delegation grants, durable transitions, or writeback policy.

Depends on `@openomni/protocol`, `@openomni/policy`, `@openomni/session`, `@openomni/llm`, `@openomni/openomni`, `@openomni/coordinator`, and `@openomni/agent`. `tool/mcp/mcp-prefix-guard.ts` is the current direct `@openomni/policy` consumer; it creates a generic engine for the canonical `tool.mcp.pre` guard. Direct `@openomni/agent` imports are concentrated in `agents/`, `context/middleware.ts`, `execution/worker-runner*.ts`, and the MCP provider code.

## STRUCTURE

```
src/
├── index.ts              # Entry — calls bootstrap/main()
├── config.ts             # loadConfig() — reads env / config files into ServerConfig
├── recovery.ts           # Crash-recovery glue (delegates to bootstrap/recovery)
├── bootstrap/
│   ├── index.ts          # main() — starts the injected P2 runtime, host services, channels, recovery, and shutdown
│   ├── kernel-services.ts # Thin composition: binds host dependencies to OpenOmni production semantic services
│   ├── p2-runtime.ts     # Production strict-baseline runtime open/close and validated credential/model environment
│   ├── channels.ts       # createChannelAdapters() — Discord / Telegram / GitHub / WebSocket setup + triggers
│   ├── dispatch-owners.ts # wires host-owned connector/outbound/device drivers
│   ├── resident-inbound-wait.ts # resident-side inbound-wait bridge
│   ├── worker-bootstrap.ts # public non-secret Worker bootstrap metadata
│   ├── mcp.ts            # connects configured MCP servers
│   ├── recovery.ts       # ledger-backed startup reconciliation before producers start
│   └── shutdown.ts       # graceful close for channels, workers, MCP, and the ledger runtime
├── channel/
│   ├── index.ts          # Re-exports adapters + WebSocketHandler
│   ├── types.ts          # Shared channel config helpers
│   ├── websocket.ts      # In-process WebSocket surface (token-gated)
│   ├── discord/          # Discord gateway client + surface (mention-trigger by default)
│   ├── telegram/         # Telegram polling surface
│   └── github/           # GitHub webhook surface (issue_comment.created, issues.opened)
├── connector/            # Server-owned provider-neutral process driver, credential transport, log telemetry, question bridge, and read-back builder
├── context/
│   ├── index.ts          # Barrel re-exports
│   ├── assembler.ts      # ContextAssembler.assemble() — builds system prompt context from workspace
│   ├── find-up.ts        # findUp() — walks up directory tree to locate config files
│   ├── instructions.ts   # InstructionLoader — loads AGENTS.md / CLAUDE.md instruction files
│   ├── mcp-config.ts     # McpConfigLoader.discover() / merge() — project-level MCP server config
│   ├── middleware.ts      # createContextMiddleware() — canonical prompt.context.pre policy that appends context
│   └── skills.ts         # SkillLoader — loads skill definitions from workspace
├── execution/
│   ├── coordinator.ts    # createExecutionCoordinator() — wraps createWorkerManager(config, ports); binds events/toolRelay/inboundWait ports (#477)
│   ├── recovery.ts       # recoverInterruptedRuns() — marks non-terminal runs interrupted at boot (moved from coordinator, #477)
│   ├── worker-entry.ts   # Worker process entry — IPC server, ChatAgent execution
│   ├── worker-runner*.ts # Worker-side run loop, IPC handlers, events, types
│   ├── worker-bootstrap-handler.ts # Validates public bootstrap metadata and readiness
│   ├── p2-worker-provisioning.ts # Private provider-scoped credential transfer, binding, scrubbing, and receipt validation
│   └── worker-runtime.ts # Creates execution context only from the provisioned model environment
├── handler/
│   └── conversation.ts   # createMessageHandler() — queues per surfaceKey, calls OpenOmni kernel/IngressEngine
├── ingress/
│   └── bridge.ts         # Transitional Adapter.InboundMessage → OpenOmni inbound bridge
├── agents/
│   ├── index.ts          # createAllAgents() — builds the full agent registry map
│   ├── registry.ts       # Per-server AgentDefinition registry (keyed by name)
│   ├── types.ts          # AgentDefinition + factory types
│   ├── model-resolution.ts # resolveRuntimeModel() — alias resolution for per-message models
│   └── dev-agent/        # Default "dev" agent factory + prompt
├── profile/
│   └── resident.ts       # createResidentProfile() — file-based profile loader with hot reload
├── tool/
│   ├── custom/           # CustomToolProvider — user-defined tool provider
│   └── mcp/              # McpToolProvider — MCP-backed tool provider
├── server/
│   └── routes.ts         # createRouter(githubWebhookHandler) — Hono app (health, /github/webhook, …)
└── shared/               # Cross-module helpers (chunk-text, dedupe, fetch-retry, sleep, trigger)
```
## P2-04 PRODUCTION COMPOSITION

- `src/index.ts` creates `createProductionComposition(loadConfig())`; there is no alternate production bootstrap path.
- `bootstrap/p2-runtime.ts` opens the strict `p2-clean-v1` runtime, loads Owner credentials into the LLM-owned secret registry, validates the explicit model environment/catalog binding, and closes the one lifetime writer after producers stop.
- `bootstrap/kernel-services.ts` is thin composition only. It binds session structural ports, OpenOmni production semantic services under `packages/openomni/src/ledger/production/`, host drivers, observation, credentials, and recovery. Product transition and lifecycle meaning must not be added here.
- Workers receive public bootstrap metadata separately from private, minimal, provider-scoped credential material. The private local transfer is authenticated and run-bound; the Worker scrubs transfer buffers and must send the post-provisioning acknowledgement before execution starts.
- Server owns host/transport/process/credential wiring only. OpenOmni owns native transition meaning, session owns the sole structural writer/query/projection runtime, coordinator owns process supervision, and LLM owns credential custody/provider behavior/cache.
- **P2-05–P2-07, C1, P3, and P4 remain unshipped.** P3 still owns moving `resident/` and `agents/` into this host.

## BOOT SEQUENCE (`bootstrap/index.ts`)

1. `loadConfig()` and `createProductionComposition()` validate the explicit Owner model and workspace identity.
2. Open the exclusive `p2-clean-v1` ledger runtime; synchronously rebuild the closed projection set.
3. Load Owner credentials into the LLM-owned registry and validate the frozen model environment plus derived catalog cache.
4. Compose OpenOmni production semantic services through the thin `bootstrap/kernel-services.ts` binding.
5. Create tool/MCP providers, the coordinator, authenticated Worker transition/query/provisioning ports, and host-owned connector/outbound/device drivers.
6. Run ledger-backed recovery before any channel producer starts.
7. Create the message handler and Discord / Telegram / GitHub / WebSocket adapters, then start HTTP/WebSocket and channels.
8. Start `CronJobRunner` over the injected ledger-backed schedule service.
9. On shutdown, stop producers and workers before closing the sole ledger runtime.

`OPENOMNI_MODE=local` remains disabled. Resident conversation may execute in-process, but Worker execution always crosses the coordinator boundary.

## MESSAGE FLOW

```
Adapter.InboundMessage
  ↓ handler/conversation.ts — createMessageHandler
  ├─ per-surfaceKey FIFO queue (avoids concurrent ingestion for the same surface)
  └─ processMessage()
        ├─ normalize/queue only server-owned concerns
        ├─ hand canonical inbound facts to @openomni/openomni
        ├─ OpenOmni resolves principal, access, correlation, session, target, agent/runtime
        └─ toResponseText(result) → agent output | "(no response)"
```

Errors bubble up as `Error: {message}` strings back to the channel so operators can see failures instead of silent drops.

The current `conversation.ts` / `ingress/bridge.ts` path still contains transitional routing, model, and tool-selection logic. Do not add new product semantics there. Move new logic into `packages/openomni` and shrink the server bridge over time.

## TOOL SYSTEM

Tool providers are assembled in `bootstrap/index.ts` and passed through to the routing handler and worker manager:

| Provider | Source | Notes |
| --- | --- | --- |
| `SystemToolProvider` | `@openomni/openomni` | read / glob / grep / write / edit / bash |
| `AgentToolProvider` | `@openomni/openomni` | `dispatch` egress command tool |
| `McpToolProvider` | `src/tool/mcp/` | one provider per MCP connection |
| `CustomToolProvider` | `src/tool/custom/` | user-defined tools |
`createToolExecutor` (from `@openomni/openomni`) dispatches by sanitized name (periods → underscores), enforces `Policy.Permission`, applies tier-based timeouts, and returns an error-shaped `Tool.Result` on denial / timeout / unknown tool.

## CONNECTORS

The server connector surface hosts provider-neutral process, private credential transport, log/question-bridge, and read-back plumbing. Installation discovery/register/consent UX and full smoke verification remain unshipped under #216. OpenOmni receives normalized host-driver owners and retains all connector lifecycle meaning. See [`../../docs/implementation-status.md`](../../docs/implementation-status.md).

## CHANNELS

| Channel | Trigger defaults | Delivery |
| --- | --- | --- |
| Telegram | (optional sender allowlist) | `final` (post once at the end) |
| GitHub | `issue_comment.created`, `issues.opened` (+ sender allowlist) | `final`; webhook handler wired into the Hono router |
| Discord | mention trigger (+ optional sender allowlist) | `final` |
| WebSocket | built-in (token-gated via `config.server.wsToken`) | streaming |

Add a new channel by:
1. Creating an adapter under `src/channel/{name}/` implementing `Adapter.Surface` (or wrap an existing SDK).
2. Registering it in `bootstrap/channels.ts` behind a config flag.
3. Surfacing it over HTTP in `server/routes.ts` if it needs a webhook endpoint.

Channel adapters may:

- verify raw transport authenticity (tokens, signatures, gateway identity);
- dedupe transport deliveries;
- normalize raw payloads into channel-agnostic inbound facts;
- send the response returned by OpenOmni.

Channel adapters must not:

- inspect durable Wait, surface, grant, or blocklist projections for routing;
- decide Resident vs Worker vs external actor target;
- choose writeback/projection behavior;
- implement OpenOmni access policy.

## AGENT REGISTRY

- `apps/server/src/agents/registry.ts` is the **server-local** agent registry (keyed by name); the former `AgentRegistry` in `@openomni/agent` was removed in the P0 dead-code sweep (#453).
- Each entry is an `AgentDefinition` with `model`, `systemPrompt`, `tools`, optional `budget`, optional `permissions`, and trigger metadata (slash command / channel list).
- Unknown agent names fail with typed sanitized errors. Resident and Worker construction require the explicitly configured, environment-bound model; no ambient or substitute model is selected.
- `apps/server/src/agents/dev-agent/` is the default agent factory + prompt.

This registry is transitional runtime configuration. Product routing should move toward OpenOmni-owned agent/runtime resolution rather than server-side per-message routing.

## RESIDENT PROFILE

`src/profile/resident.ts` provides `createResidentProfile()` which loads a Resident profile from `~/.openomni/profile/` (or `OPENOMNI_PROFILE_DIR`). The base system prompt comes from `ResidentAgent.getPrompt()` in `@openomni/openomni`, which selects a model-specific variant (Claude or GPT). Optional overlay files — `SOUL.md` (persona identity), `USER.md`, `MEMORY.md`, and `config.yaml` — are appended when present. None are required; without any files the built-in prompt is used as-is. The profile is hot-reloaded on file change via `fs.watch`. The factory produces an `AgentDefinition` used by the bootstrap to register the Resident agent.

## CONTEXT SYSTEM

`src/context/` assembles the system prompt context injected into each agent run:

- `ContextAssembler.assemble({ workspaceRoot })` — reads AGENTS.md, CLAUDE.md, skill files, and MCP config from the workspace tree.
- `createContextMiddleware(config)` — wraps the assembler as a canonical `prompt.context.pre` registration for `ChatAgent`, declaring the `prompt.append_context` effect capability.
- `McpConfigLoader.discover(root)` / `merge(...)` — finds and merges project-level MCP server configs.
- `InstructionLoader` / `SkillLoader` — load instruction and skill files from the workspace.

## ANTI-PATTERNS

- **Bypassing `createMessageHandler`**: all message handling should flow through the per-surface FIFO queue so one surface cannot interleave runs.
- **Channel logic outside server**: all channel work lives here. Do not add channel adapters to scripts or tooling packages.
- **Ad-hoc tool permission logic**: if a new policy is needed, extend `Policy.Permission` and enforce it inside `createToolExecutor` (from `@openomni/openomni`), not inside individual tools.
- **Server-side product lifecycle**: do not add Wait matching, session routing, grant checks, actor trust, Work/Attempt transitions, schedule/effect meaning, or completion admission here. Add that to OpenOmni production services.

## KNOWN TECH DEBT

- `recovery.ts` is a thin wrapper around `bootstrap/recovery.ts` — consolidate when the recovery model stabilizes.
- `resolveRuntimeModel` currently resolves aliases per message; caching is a future optimization once usage patterns are clearer.
- `execution/worker-entry.ts` is large; extracting lifecycle helpers would improve readability.
