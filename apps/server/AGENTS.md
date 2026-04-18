# apps/server

Hono server that hosts the orchestration layer and exposes it through external channels (Discord / Telegram / GitHub / WebSocket). This is where inbound messages actually run: bootstrap → channel adapter → routing handler → `IngressEngine.ingest()` → response back to the channel.

Depends on `@openomni/protocol`, `@openomni/session`, `@openomni/llm`, `@openomni/openomni`. Does **not** import from `@openomni/agent` directly — all agent work goes through `@openomni/openomni`'s `IngressEngine`.

## STRUCTURE

```
src/
├── index.ts              # Entry — calls bootstrap/main()
├── config.ts             # loadConfig() — reads env / config files into ServerConfig
├── router.ts             # resolveAgentName() — per-message agent resolution (slash command, channel, default)
├── routes.ts             # createRouter(githubWebhookHandler) — Hono app (health, /github/webhook, …)
├── recovery.ts           # Crash-recovery glue (delegates to bootstrap/recovery)
├── bootstrap/
│   ├── index.ts          # main() — wires storage, tool providers, model, channels, server, recovery, shutdown
│   ├── channels.ts       # createChannelAdapters() — Discord / Telegram / GitHub / WebSocket setup + triggers
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
├── handler/
│   ├── conversation.ts   # createMessageHandler() — queues per surfaceKey, calls IngressEngine
│   └── surface-store.ts  # Per-surface routing memory
├── ingress/
│   ├── bridge.ts         # buildInboundEvent() — Adapter.InboundMessage → InboundEvent (+ tool selection, toolExecutor)
│   └── mode.ts           # detectMode() — "/plan …" prefix → plan mode, else direct
├── agents/
│   ├── registry.ts       # Per-server AgentDefinition registry (keyed by name)
│   ├── types.ts          # AgentDefinition + factory types
│   ├── model-resolution.ts # resolveRuntimeModel() — alias resolution for per-message models
│   └── dev-agent/        # Default "dev" agent factory + prompt
├── tool/
│   ├── index.ts          # Barrel
│   ├── types.ts          # ToolProvider, NativeTool, ToolCategory, ToolRiskTier, ToolExecutorConfig
│   ├── define.ts         # defineTool() helper + metadata resolution
│   ├── executor.ts       # createToolExecutor() — permission + tier-based timeout wrapper
│   ├── system/           # Tier 0–2: read / glob / grep / write / edit / bash
│   ├── agent/            # Agent-category tools (subagent delegation)
│   ├── mcp/              # MCP-backed tool provider
│   ├── builtins/         # Shared tool primitives used across providers
│   └── shared/           # Utilities shared between tool providers
├── filesystem/           # Workspace-scoped filesystem helpers (used by system tools)
├── shared/               # Cross-module helpers
└── server/               # Low-level Hono wiring (consumed by routes.ts)
```

## BOOT SEQUENCE (`bootstrap/index.ts`)

1. `loadConfig()` — read env + config files.
2. `initialize({ dbPath })` — bootstrap `@openomni/session` SQLite storage.
3. Create tool providers: `SystemToolProvider`, `AgentToolProvider`, `McpToolProvider`.
4. `connectMcpServers(config, mcpProvider)` — dial each configured MCP server.
5. `resolveModel()` — pick a default model from stored credentials (if any).
6. Build `routingHandler = createMessageHandler({ systemProvider, agentProvider, mcpProvider, defaultModel, workspaceRoot })`.
7. `createChannelAdapters(config, routingHandler)` — attach Discord / Telegram / GitHub / WebSocket with their trigger rules and delivery policies.
8. `createRouter(githubWebhookHandler)` + `Bun.serve()` — HTTP + WebSocket endpoints.
9. Start each channel (`channel.start()` in parallel).
10. `runRecovery(routingHandler)` — resume sessions that were busy before last shutdown.
11. `installShutdownHandlers({ channels, server, mcpProvider })` — graceful stop on SIGINT / SIGTERM.

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
        │     ├─ detectMode(text) → "plan" | "direct"
        │     ├─ getAgentDefinition(agentName) (falls back to a generic definition)
        │     ├─ selectTools(definition, providers) → Tool.Spec[] (sanitized names)
        │     └─ AgentDef = { model, systemPrompt, tools, budget, toolExecutor }
        ├─ resolveRuntimeModel(event.agent.model, defaultModel)
        ├─ IngressEngine.ingest(event) ← @openomni/openomni
        └─ toResponseText(result) → "Plan generated: …" | agent output | "(no response)"
```

Errors bubble up as `Error: {message}` strings back to the channel so operators can see failures instead of silent drops.

## TOOL SYSTEM (3 CATEGORIES)

`ToolCategory = "system" | "agent" | "mcp"` — defined in `tool/types.ts`.

| Category | Tier | Examples | Notes |
| --- | --- | --- | --- |
| `system` | 0 (read-only) | `read`, `glob`, `grep` | Tier 0 timeout: 30s default |
| `system` | 1 (local write) | `write`, `edit` | Tier 1 timeout: 30s default |
| `system` | 2 (bash) | `bash` | Logged; future human-approval gate |
| `agent` | — | `subagent` | Delegates via `@openomni/openomni` SubagentRuntime / BackgroundManager |
| `mcp` | — | configured MCP tools | One provider per MCP connection |

`createToolExecutor({ tools, config })` dispatches by sanitized name (periods → underscores), enforces `Guardrail.ToolPermission`, applies a tier-based timeout (`tier0/tier1/tier2` overridable in config), and returns an error-shaped `Tool.Result` on denial / timeout / unknown tool.

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
3. Surfacing it over HTTP in `routes.ts` if it needs a webhook endpoint.

## AGENT REGISTRY

- `apps/server/src/agents/registry.ts` is a **server-local** agent registry (keyed by name) distinct from the `AgentRegistry` inside `@openomni/agent`.
- Each entry is an `AgentDefinition` with `model`, `systemPrompt`, `tools: { system, agent, mcp }` (selection flags or allowlists), optional `budget`, optional `permissions`, and trigger metadata (slash command / channel list).
- `getAgentDefinition(name)` returns `undefined` when the agent is unknown, in which case `ingress/bridge.ts` falls back to a generic definition plus the configured default model.
- `apps/server/src/agents/plan-agent/` provides a plan-specific agent definition (`index.ts`) and system prompt (`prompt.ts`) for plan mode execution.

## ANTI-PATTERNS

- **Direct `@openomni/agent` imports**: server → openomni → agent. Never import `ChatAgent` / `SubagentTool` / etc. directly in this app; go through `IngressEngine`.
- **Bypassing `createMessageHandler`**: all message handling should flow through the per-surface FIFO queue so one surface cannot interleave runs.
- **New channel logic in `apps/cli`**: CLI is intentionally minimal (auth + config). All channel work lives here.
- **Ad-hoc tool permission logic**: if a new policy is needed, extend `Guardrail.ToolPermission` and enforce it inside `createToolExecutor`, not inside individual tools.

## KNOWN TECH DEBT

- `recovery.ts` is a thin wrapper around `bootstrap/recovery.ts` — consolidate when the recovery model stabilizes.
- `resolveRuntimeModel` currently resolves aliases per message; caching is a future optimization once usage patterns are clearer.
