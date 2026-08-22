# apps/server

Hono/Bun runtime host that exposes OpenOmni through external channels (Discord / Telegram / GitHub / WebSocket — adapter implementations live in `packages/channels` since #551; the server registers them), connector processes, MCP/custom tools, and worker entrypoints. The server owns transport wiring and bootstrap, not product messaging/access semantics.

Inbound messages flow as: raw channel payload -> channels gateway driver transport/auth/dedupe (`packages/channels`) -> normalized inbound facts/envelope -> gateway router `ingest` (`@openomni/channels` `createGatewayRouter`: sanitization, actor resolution, resolveRoute + `route.decided` recording, wait resumption, surface-session claim) -> brain Deliver consumer (`packages/openomni` ingress) -> response back to the channel. Server code must not decide PendingInteraction/PendingAsk routing, session target, principal trust, delegation grants, or writeback — since #707 stage 2 that judgment lives in the gateway router; the server only composes the ports.

Depends on `@openomni/protocol`, `@openomni/policy`, `@openomni/ledger`, `@openomni/llm`, `@openomni/openomni`, `@openomni/coordinator`, `@openomni/channels`, and `@openomni/agent`. `tool/mcp/mcp-prefix-guard.ts` is the current direct `@openomni/policy` consumer; it creates a generic engine for the canonical `tool.mcp.pre` guard. Direct `@openomni/agent` imports are concentrated in `agents/`, `context/middleware.ts`, `execution/worker-runner*.ts`, and the MCP provider code.

## STRUCTURE

```
src/
├── index.ts              # Entry — calls bootstrap/main()
├── config.ts             # loadConfig() — reads env / config files into ServerConfig (incl. permissionProfiles: 고도화 A per-tier deny-label tool caps, fail-closed empty)
├── recovery.ts           # Crash-recovery glue (delegates to bootstrap/recovery)
├── bootstrap/
│   ├── index.ts          # main() — wires storage, tool providers, resolveModel() (providers.ts merged here, #476), brain engine + gateway router (createGatewayRouter, #707), channels, server, recovery, shutdown
│   ├── channels.ts       # createChannelAdapters() — registers @openomni/channels adapters (Discord / Telegram / GitHub / WebSocket) + triggers, binds the publish port, fills the router's delivery-route map
│   ├── dispatch-owners.ts # wires dispatch handler owners (connector driver, outbound, device)
│   ├── resident-inbound-wait.ts # resident-side inbound-wait bridge for worker resident.ask
│   ├── worker-bootstrap.ts # builds the WorkerBootstrap payload (configEpoch, agents, tool catalog, credentials); per-run policyPlan travels on Execution.Request, not here
│   ├── mcp.ts            # connectMcpServers() — fires up each configured MCP server
│   ├── recovery.ts       # runRecovery() — resumes incomplete sessions on startup
│   └── shutdown.ts       # installShutdownHandlers() — graceful stop for server / channels / MCP
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
│   └── bridge.ts         # Transitional Channel.InboundMessage → OpenOmni inbound bridge
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
└── server/
    └── routes.ts         # createRouter(githubWebhookHandler) — Hono app (health, /github/webhook, …)
```

Channel adapter implementations (discord/, telegram/, github/, websocket, authn, support helpers) moved to `packages/channels` (#551, gateway stage 1), and the perimeter router (resolveRoute external arms, wait service, #215 send kernel) followed at stage 2 (#707/#736); this app keeps only driver registration in `bootstrap/channels.ts` and router composition in `bootstrap/index.ts`.

## BOOT SEQUENCE (`bootstrap/index.ts`)

OpenOmni always runs inbound execution through the coordinator. `OPENOMNI_MODE=local` is disabled and fails during bootstrap.

**Coordinator mode**:
1. `loadConfig()` — read env + config files.
2. `initialize({ dbPath })` — bootstrap `@openomni/ledger` SQLite storage.
3. Create tool providers: `SystemToolProvider`, `AgentToolProvider`, `McpToolProvider`, `CustomToolProvider`.
4. `connectMcpServers(config, mcpProvider)` — dial each configured MCP server.
5. `resolveModel()` (in `bootstrap/index.ts`) — pick a default model from stored credentials (if any); kernel-side fallback is `DEFAULT_DISPATCH_MODEL` from `@openomni/openomni` (#471).
6. `createExecutionCoordinator(...)` — wraps `createWorkerManager(config, ports)`; the server is the composition root that binds the event sink (`Bus.publish`), tool relay, and inbound-wait ports (#477). MCP tools are covered by the tool relay.
7. `createBrainEngine({ coordinator, residentRuntime, agentResolver, dispatchRuntime, externalAgentResolver, claimSurface })` — the brain's Deliver consumer + internal-route arm; internal surface-session claims cross the gateway router's `claimSurface` port (#708).
8. `createGatewayRouter({ sink: Bus.publish, deliver: ingressEngine.deliver, messaging: { deliveryRoutes, grants, replyGrantRules, budgets } })` (#707 stage 2) — perimeter routing + wait service + the #215 send kernel; then `routingHandler = createMessageHandler({ ingress: gatewayRouter })`.
9. `createChannelAdapters(config, routingHandler, deliveryRoutes)` — attach Discord / Telegram / GitHub / WebSocket (adapters fill the router's delivery-route map); `registerServerMessaging(...)` records the send-seam boot receipt.
10. `createRouter(githubWebhookHandler)` + `Bun.serve()` — HTTP + WebSocket endpoints.
11. Start each channel (`channel.start()` in parallel).
12. `runRecovery(routingHandler, coordinator, traceId)` — resume sessions interrupted before last shutdown.
13. `CronJobRunner.start({ fire: (job) => CronAdapter.fire(job, ingressEngine) })` — reload persisted schedules and fire due cron jobs through the injected ingress engine instance (#549).
14. `installShutdownHandlers({ channels, server, mcpProvider, coordinator, cronRunner })` — graceful stop on SIGINT / SIGTERM.

**Local mode** (`OPENOMNI_MODE=local`): disabled. Do not add in-process `ChatAgent` execution paths.

## MESSAGE FLOW

```
Channel.InboundMessage
  ↓ handler/conversation.ts — createMessageHandler({ ingress: gatewayRouter })
  ├─ per-surfaceKey FIFO queue (avoids concurrent ingestion for the same surface)
  └─ buildInboundEvent() → GatewayRouter.ingest()
        ├─ router (packages/channels): sanitize, resolve actor, resolveRoute, record route.decided,
        │  wait/pending resumption, routed pre-run authority, surface-session claim
        ├─ brain (packages/openomni ingress deliver): session materialization/placement, projection, execution
        └─ toResponseText(result) → agent output | "(no response)"
```

Errors bubble up as `Error: {message}` strings back to the channel so operators can see failures instead of silent drops.

The current `conversation.ts` / `ingress/bridge.ts` path still contains transitional model and tool-selection logic; per-message routing back doors were deleted when the kernel's unified `resolveRoute` shipped (#464, PR #485). Do not add new product semantics there. Move new logic into `packages/openomni` and shrink the server bridge over time.

## MESSAGING CONFIG (`config.json` → `messaging`, #215 / #708 / #219)

`config.ts` resolves the outbound `messaging` block; every resolver is fail-closed (a malformed entry is dropped with an `Operational.Warn`, never a crash):

- `grants` — Owner-written standing `SenderTargetGrant`s (authority: MAY the persona reach a target at all). Default EMPTY = every cold send is `ungranted`.
- `personaActorId` — the as-me persona actor; unset → `message.send` fails closed.
- `replyGrantRules` — `ReplyGrantRule`s the gateway materializes bounded reply-scoped grant instances from on first contact (§2b).
- `socialBudget` (#219) — Owner-declared active-egress caps (HOW OFTEN the persona may COLD-contact each target). Wiring the source engages the synchronous egress gate in the send kernel; the gate evaluates AFTER the grant (authority) and BEFORE the Wait/delivery, so a suppressed outreach records a typed `denied` receipt (`budget_exhausted` / `cooldown_suppressed` / `dnc_denied`) without opening a Wait or emitting bytes. **Default EMPTY is FAIL-SAFE, not permissive**: a cold proactive send to a target with NO budget entry is capped at ZERO (suppressed `budget_exhausted`). Replies (reply-scoped grant instances) always bypass the gate — absence of a budget never throttles the reply path. The debit ledger (`EgressBudgetStore`, perimeter domain) is written record-before-act on admission, so split outreach across calls cannot evade the cap and cooldown survives restart.

```json
{
  "messaging": {
    "personaActorId": "actor-persona",
    "grants": [
      { "id": "g-seller", "senderId": "actor-persona", "targetActorId": "actor-seller", "operations": ["awaited", "fire_and_forget"] }
    ],
    "socialBudget": [
      {
        "id": "budget-seller",
        "targetActorId": "actor-seller",
        "maxPerWindow": 3,
        "windowMs": 86400000,
        "cooldownMs": 3600000,
        "classCaps": { "notify": 1 },
        "quietHours": { "startMinuteUtc": 1320, "endMinuteUtc": 480 },
        "doNotContact": false
      }
    ]
  }
}
```

The autonomous timer-fired 봉수 escalation ladder is deliberately OUT of #219 v1 (deferred — blocked by the #469 accumulator + a missing periodic-timeout firing source); the send kernel leaves a seam comment where the escalation coordinate would attach.

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
| WebSocket | built-in (token-gated when `config.server.wsToken` is set — subprotocol `auth` token preferred, query token deprecated; without a configured token upgrades are open and marked unauthenticated) | one JSON `{type:"response"}` frame per inbound message (no streaming) |

Add a new channel by:
1. Creating a driver under `packages/channels/src/{name}/` implementing `Channel.Surface` (or wrap an existing SDK) — it must stay on the band import contract (`packages/channels/AGENTS.md`).
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
- **Channel logic outside its band**: channel adapter implementations live in `packages/channels`; the server only registers and composes them. Do not add adapter code here or to scripts/tooling packages.
- **Ad-hoc tool permission logic**: if a new policy is needed, extend `Policy.Permission` and enforce it inside `createToolExecutor` (from `@openomni/openomni`), not inside individual tools.
- **Server-side product routing**: do not add PendingInteraction/PendingAsk matching, SurfaceKey session routing, worker grant checks, channel grant checks, or actor trust decisions here. Move that to `packages/openomni`.

## KNOWN TECH DEBT

- `recovery.ts` is a thin wrapper around `bootstrap/recovery.ts` — consolidate when the recovery model stabilizes.
- `resolveRuntimeModel` currently resolves aliases per message; caching is a future optimization once usage patterns are clearer.
- `execution/worker-entry.ts` is large; extracting lifecycle helpers would improve readability.
