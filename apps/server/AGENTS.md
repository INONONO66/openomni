# apps/server

Hono server that hosts the orchestration layer and exposes it through external channels (Discord / Telegram / GitHub / WebSocket). This is where inbound messages actually run: bootstrap → channel adapter → routing handler → `IngressEngine.ingest()` → response back to the channel.

Depends on `@openomni/protocol`, `@openomni/session`, `@openomni/llm`, `@openomni/openomni`, `@openomni/coordinator`, and `@openomni/agent`. The `execution/worker-entry.ts` and `bootstrap/local-runner.ts` import `ChatAgent` from `@openomni/agent` directly; `context/middleware.ts` and `agents/` also import agent types directly.

## STRUCTURE

```
src/
├── index.ts              # Entry — calls bootstrap/main()
├── config.ts             # loadConfig() — reads env / config files into ServerConfig
├── router.ts             # resolveAgentName() — per-message agent resolution (slash command, channel, default)
├── recovery.ts           # Crash-recovery glue (delegates to bootstrap/recovery)
├── bootstrap/
│   ├── index.ts          # main() — wires storage, tool providers, model, channels, server, recovery, shutdown
│   ├── channels.ts       # createChannelAdapters() — Discord / Telegram / GitHub / WebSocket setup + triggers
│   ├── local-runner.ts   # LocalRunner.create() — in-process CoordinatorLike for OPENOMNI_MODE=local
│   ├── providers.ts      # resolveModel() — picks a default LLM model from stored credentials
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
├── context/
│   ├── index.ts          # Barrel re-exports
│   ├── assembler.ts      # ContextAssembler.assemble() — builds system prompt context from workspace
│   ├── find-up.ts        # findUp() — walks up directory tree to locate config files
│   ├── instructions.ts   # InstructionLoader — loads AGENTS.md / CLAUDE.md instruction files
│   ├── mcp-config.ts     # McpConfigLoader.discover() / merge() — project-level MCP server config
│   ├── middleware.ts      # createContextMiddleware() — on_system_prompt middleware that appends context
│   └── skills.ts         # SkillLoader — loads skill definitions from workspace
├── execution/
│   ├── coordinator.ts    # createExecutionCoordinator() + buildToolDispatcher() — worker pool wrapper
│   ├── worker-entry.ts   # Worker process entry — IPC server, ChatAgent execution
│   └── worker-runtime.ts # createExecutionToolContext() + resolveWorkerDbPath() — shared worker helpers
├── handler/
│   └── conversation.ts   # createMessageHandler() — queues per surfaceKey, calls IngressEngine
├── ingress/
│   ├── bridge.ts         # buildInboundEvent() — Adapter.InboundMessage → InboundEvent (+ tool selection, toolExecutor)
│   └── mode.ts           # detectMode() — direct mode
├── agents/
│   ├── index.ts          # createAllAgents() — builds the full agent registry map
│   ├── registry.ts       # Per-server AgentDefinition registry (keyed by name)
│   ├── types.ts          # AgentDefinition + factory types
│   ├── model-resolution.ts # resolveRuntimeModel() — alias resolution for per-message models
│   └── dev-agent/        # Default "dev" agent factory + prompt
├── tool/
│   ├── custom/           # CustomToolProvider — user-defined tool provider
│   └── mcp/              # McpToolProvider — MCP-backed tool provider
├── server/
│   └── routes.ts         # createRouter(githubWebhookHandler) — Hono app (health, /github/webhook, …)
└── shared/               # Cross-module helpers (chunk-text, dedupe, fetch-retry, sleep, trigger)
```

## BOOT SEQUENCE (`bootstrap/index.ts`)

Two execution modes are selected by `OPENOMNI_MODE` env var:

**Coordinator mode** (default):
1. `loadConfig()` — read env + config files.
2. `initialize({ dbPath })` — bootstrap `@openomni/session` SQLite storage.
3. Create tool providers: `SystemToolProvider`, `AgentToolProvider`, `McpToolProvider`, `CustomToolProvider`, `TaskToolProvider`, `TodoToolProvider`.
4. `connectMcpServers(config, mcpProvider)` — dial each configured MCP server.
5. `resolveModel()` — pick a default model from stored credentials (if any).
6. `createExecutionCoordinator({ workerScript, bootstrap, toolDispatcher })` — spawn worker pool; `toolDispatcher` covers MCP, task, and todo tools.
7. `IngressEngine.setCoordinator(coordinator)`.
8. Build `routingHandler = createMessageHandler({ systemProvider, agentProvider, mcpProvider, customProvider, taskProvider, todoProvider, defaultModel, workspaceRoot })`.
9. `createChannelAdapters(config, routingHandler)` — attach Discord / Telegram / GitHub / WebSocket.
10. `createRouter(githubWebhookHandler)` + `Bun.serve()` — HTTP + WebSocket endpoints.
11. Start each channel (`channel.start()` in parallel).
12. `runRecovery(routingHandler, coordinator, traceId)` — resume sessions interrupted before last shutdown.
13. `installShutdownHandlers({ channels, server, mcpProvider, coordinator })` — graceful stop on SIGINT / SIGTERM.

**Local mode** (`OPENOMNI_MODE=local`):
- Skips worker pool; uses `LocalRunner.create(...)` as the `CoordinatorLike`.
- `LocalRunner` runs `ChatAgent` in-process via `bootstrap/local-runner.ts`.

## MESSAGE FLOW

```
Adapter.InboundMessage
  ↓ handler/conversation.ts — createMessageHandler
  ├─ per-surfaceKey FIFO queue (avoids concurrent ingestion for the same surface)
  └─ processMessage()
        ├─ resolveAgentName({ message, defaultAgent: "dev" })
        │     ├─ slash command trigger → agent.triggers.slashCommand
        │     ├─ channel trigger       → agent.triggers.channels
        │     └─ else                  → default "dev"
        ├─ buildInboundEvent(message, agentName, deps)
        │     ├─ detectMode(text) → "direct"
        │     ├─ getAgentDefinition(agentName) (falls back to a generic definition)
        │     ├─ selectTools(definition, providers) → Tool.Spec[] (sanitized names)
        │     └─ AgentDef = { model, systemPrompt, tools, budget, toolExecutor }
        ├─ resolveRuntimeModel(event.agent.model, defaultModel)
        ├─ IngressEngine.ingest(event) ← @openomni/openomni
        └─ toResponseText(result) → agent output | "(no response)"
```

Errors bubble up as `Error: {message}` strings back to the channel so operators can see failures instead of silent drops.

## TOOL SYSTEM

Tool providers are assembled in `bootstrap/index.ts` and passed through to the routing handler and worker pool:

| Provider | Source | Notes |
| --- | --- | --- |
| `SystemToolProvider` | `@openomni/openomni` | read / glob / grep / write / edit / bash |
| `AgentToolProvider` | `@openomni/openomni` | subagent delegation tools |
| `McpToolProvider` | `src/tool/mcp/` | one provider per MCP connection |
| `CustomToolProvider` | `src/tool/custom/` | user-defined tools |
| `TaskToolProvider` | `@openomni/openomni` | task management tools |
| `TodoToolProvider` | `@openomni/openomni` | todo list tools |

`createToolExecutor` (from `@openomni/openomni`) dispatches by sanitized name (periods → underscores), enforces `Guardrail.ToolPermission`, applies tier-based timeouts, and returns an error-shaped `Tool.Result` on denial / timeout / unknown tool.

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

## AGENT REGISTRY

- `apps/server/src/agents/registry.ts` is a **server-local** agent registry (keyed by name) distinct from the `AgentRegistry` inside `@openomni/agent`.
- Each entry is an `AgentDefinition` with `model`, `systemPrompt`, `tools`, optional `budget`, optional `permissions`, and trigger metadata (slash command / channel list).
- `getAgentDefinition(name)` returns `undefined` when the agent is unknown, in which case `ingress/bridge.ts` falls back to a generic definition plus the configured default model.
- `apps/server/src/agents/dev-agent/` is the default agent factory + prompt.

## CONTEXT SYSTEM

`src/context/` assembles the system prompt context injected into each agent run:

- `ContextAssembler.assemble({ workspaceRoot })` — reads AGENTS.md, CLAUDE.md, skill files, and MCP config from the workspace tree.
- `createContextMiddleware(config)` — wraps the assembler as an `on_system_prompt` middleware registration for `ChatAgent`.
- `McpConfigLoader.discover(root)` / `merge(...)` — finds and merges project-level MCP server configs.
- `InstructionLoader` / `SkillLoader` — load instruction and skill files from the workspace.

## ANTI-PATTERNS

- **Bypassing `createMessageHandler`**: all message handling should flow through the per-surface FIFO queue so one surface cannot interleave runs.
- **Channel logic outside server**: all channel work lives here. Do not add channel adapters to scripts or tooling packages.
- **Ad-hoc tool permission logic**: if a new policy is needed, extend `Guardrail.ToolPermission` and enforce it inside `createToolExecutor` (from `@openomni/openomni`), not inside individual tools.

## KNOWN TECH DEBT

- `recovery.ts` is a thin wrapper around `bootstrap/recovery.ts` — consolidate when the recovery model stabilizes.
- `resolveRuntimeModel` currently resolves aliases per message; caching is a future optimization once usage patterns are clearer.
- `execution/worker-entry.ts` is large; extracting lifecycle helpers would improve readability.
