# apps/server

Hono/Bun runtime host that exposes OpenOmni through external channels (Discord / Telegram / GitHub / WebSocket), connector processes, MCP/custom tools, and worker entrypoints. The server owns transport and bootstrap, not product messaging/access semantics.

Inbound messages should flow as: raw channel payload -> channel adapter transport/auth/dedupe -> normalized inbound facts/envelope -> OpenOmni messaging kernel -> response back to the channel. Server code must not decide PendingInteraction/PendingAsk routing, session target, principal trust, delegation grants, or writeback.

Depends on `@openomni/protocol`, `@openomni/policy`, `@openomni/session`, `@openomni/llm`, `@openomni/openomni`, `@openomni/coordinator`, and `@openomni/agent`. `tool/mcp/mcp-prefix-guard.ts` is the current direct `@openomni/policy` consumer; it creates a generic engine for the canonical `tool.mcp.pre` guard. Direct `@openomni/agent` imports are concentrated in `agents/`, `context/middleware.ts`, `execution/worker-runner*.ts`, and the MCP provider code.

## STRUCTURE

```
src/
├── index.ts              # Entry — calls bootstrap/main()
├── config.ts             # loadConfig() — reads env / config files into ServerConfig
├── recovery.ts           # Crash-recovery glue (delegates to bootstrap/recovery)
├── bootstrap/
│   ├── index.ts          # main() — wires storage, tool providers, resolveModel() (providers.ts merged here, #476), channels, server, recovery, shutdown
│   ├── channels.ts       # createChannelAdapters() — Discord / Telegram / GitHub / WebSocket setup + triggers
│   ├── dispatch-owners.ts # wires dispatch handler owners (connector driver, outbound, device)
│   ├── resident-inbound-wait.ts # resident-side inbound-wait bridge for worker resident.ask
│   ├── worker-bootstrap.ts # builds the WorkerBootstrap payload (configEpoch, agents, tool catalog, credentials); per-run policyPlan travels on Execution.Request, not here
│   ├── mcp.ts            # connectMcpServers() — fires up each configured MCP server
│   ├── recovery.ts       # runRecovery() — resumes incomplete sessions on startup
│   └── shutdown.ts       # installShutdownHandlers() — graceful stop for server / channels / MCP
├── channel/
│   ├── index.ts          # Re-exports adapters + WebSocketHandler
│   ├── types.ts          # Shared channel config helpers
│   ├── websocket.ts      # In-process WebSocket surface (token-gated)
│   ├── discord/          # Discord gateway client + surface (mention-trigger by default)
│   ├── telegram/         # Telegram polling surface
│   └── github/           # GitHub webhook surface (issue_comment.created, issues.opened)
├── connector/            # Server-owned connector process driver, log ingestion/telemetry, question bridge, read-back builder, env (definitions/discovery/registry were deleted in #473 — installations resolve from SQLite records)
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
│   ├── worker-bootstrap-handler.ts # Validates and stores WorkerBootstrap, resolves credentials, signals readiness; permissions/policyPlan are applied per run in worker-runner.ts via buildWorkerMiddleware
│   └── worker-runtime.ts # createExecutionToolContext() + resolveWorkerDbPath() — shared worker helpers
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

## BOOT SEQUENCE (`bootstrap/index.ts`)

OpenOmni always runs inbound execution through the coordinator. `OPENOMNI_MODE=local` is disabled and fails during bootstrap.

**Coordinator mode**:
1. `loadConfig()` — read env + config files.
2. `initialize({ dbPath })` — bootstrap `@openomni/session` SQLite storage.
3. Create tool providers: `SystemToolProvider`, `AgentToolProvider`, `McpToolProvider`, `CustomToolProvider`.
4. `connectMcpServers(config, mcpProvider)` — dial each configured MCP server.
5. `resolveModel()` (in `bootstrap/index.ts`) — pick a default model from stored credentials (if any); kernel-side fallback is `DEFAULT_DISPATCH_MODEL` from `@openomni/openomni` (#471).
6. `createExecutionCoordinator(...)` — wraps `createWorkerManager(config, ports)`; the server is the composition root that binds the event sink (`Bus.publish`), tool relay, and inbound-wait ports (#477). MCP tools are covered by the tool relay.
7. Configure OpenOmni kernel/ingress with coordinator, dispatch owners, agent resolver, and runtime providers.
8. Build `routingHandler = createMessageHandler({ systemProvider, agentProvider, mcpProvider, customProvider, defaultModel, workspaceRoot })`.
9. `createChannelAdapters(config, routingHandler)` — attach Discord / Telegram / GitHub / WebSocket.
10. `createRouter(githubWebhookHandler)` + `Bun.serve()` — HTTP + WebSocket endpoints.
11. Start each channel (`channel.start()` in parallel).
12. `runRecovery(routingHandler, coordinator, traceId)` — resume sessions interrupted before last shutdown.
13. `CronJobRunner.start({ fire: (job) => CronAdapter.fire(job, ingressEngine) })` — reload persisted schedules and fire due cron jobs through the injected ingress engine instance (#549).
14. `installShutdownHandlers({ channels, server, mcpProvider, coordinator, cronRunner })` — graceful stop on SIGINT / SIGTERM.

**Local mode** (`OPENOMNI_MODE=local`): disabled. Do not add in-process `ChatAgent` execution paths.

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

The current `conversation.ts` / `ingress/bridge.ts` path still contains transitional model and tool-selection logic; per-message routing back doors were deleted when the kernel's unified `resolveRoute` shipped (#464, PR #485). Do not add new product semantics there. Move new logic into `packages/openomni` and shrink the server bridge over time.

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

The current server connector surface hosts the process driver and provider-neutral ABI integration and resolves persisted installations from SQLite records/endpoints. Connector terminal envelopes transport a CompletionReport plus per-criterion references to durable WorkItem-local evidence; the server does not grade or close the WorkItem. OpenOmni resolves the verifier input from those records, projects verifier facts, and uses the same Worker-origin completion-admission boundary as internal Workers. First-party Claude Code, Codex, and OpenCode definitions do **not** currently live here: connector definitions and the unused discovery/registry modules were deleted in #473. Discover/register/consent/smoke-verify remains a planned installation lifecycle, not a shipped registry. `@openomni/openomni` receives normalized dispatch driver owners and exports no provider-specific connector manifests. See [`../../docs/implementation-status.md`](../../docs/implementation-status.md) for shipped-state truth and [`../../docs/architecture.md`](../../docs/architecture.md) for the target lifecycle.

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

- query `PendingAskStore` or `PendingInteractionStore`;
- query `SurfaceKey`, `WorkerGrantStore`, `ChannelGrantStore`, or `BlacklistStore` for routing;
- decide Resident vs Worker vs external actor target;
- choose writeback/projection behavior;
- implement OpenOmni access policy.

## AGENT REGISTRY

- `apps/server/src/agents/registry.ts` is the **server-local** agent registry (keyed by name); the former `AgentRegistry` in `@openomni/agent` was removed in the P0 dead-code sweep (#453).
- Each entry is an `AgentDefinition` with `model`, `systemPrompt`, `tools`, optional `budget`, optional `permissions`, and trigger metadata (slash command / channel list).
- `getAgentDefinition(name)` returns `undefined` when the agent is unknown; `ingress/bridge.ts`'s `buildAgentDef` then throws. Direct inbound never consults the registry — `buildResidentAgentDef` builds the Resident definition with the configured default model.
- `apps/server/src/agents/dev-agent/` is the default agent factory + prompt.

This registry is transitional runtime configuration. Product routing is OpenOmni-owned since the unified kernel `resolveRoute` shipped (#464, PR #485); the registry only feeds the bootstrap-wired agent resolver (internal events such as cron). Do not reintroduce server-side per-message routing.

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
- **Server-side product routing**: do not add PendingInteraction/PendingAsk matching, SurfaceKey session routing, worker grant checks, channel grant checks, or actor trust decisions here. Move that to `packages/openomni`.

## KNOWN TECH DEBT

- `recovery.ts` is a thin wrapper around `bootstrap/recovery.ts` — consolidate when the recovery model stabilizes.
- `resolveRuntimeModel` currently resolves aliases per message; caching is a future optimization once usage patterns are clearer.
- `execution/worker-entry.ts` is large; extracting lifecycle helpers would improve readability.
