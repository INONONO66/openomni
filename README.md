# OpenOmni

**Personal AI workforce infrastructure.**

> ⚠️ This project is under active development.

## Why

Working with AI agents today means operating tools instead of managing help. You choose the right agent, decide when to delegate, watch separate sessions, and manually carry context between them. Every session starts from scratch. Agents forget past decisions, repeat mistakes, and rediscover conventions you taught them yesterday.

When you want specialized help in a new domain — SNS operations instead of coding, research instead of writing, analysis instead of automation — you rebuild the same infrastructure again: identity, memory, tools, sessions, permissions, and review loops.

OpenOmni exists to end this cycle. You talk to one Main Persona, and that persona manages a workforce of specialized Sub Personas: hiring, summoning, evaluating, promoting, pausing, or retiring them as work evolves.

## What

OpenOmni is a personal workforce layer, not a chatbot framework.

- **One Main Persona.** The user has one default assistant identity that understands the relationship, goals, preferences, and workforce.
- **Managed Sub Personas.** Specialized personas do SNS operations, coding, research, review, and future domain work under controlled authority.
- **Isolated work sessions.** Complex work can fork into self-loop and child persona sessions so the original user session stays clean.
- **Memory-ready by design.** OpenOmni records lineage and provenance so [Anamnesis](https://github.com/inonono66/anamnesis) can later turn verified experience into long-term associative memory.
- **First domain: SNS operations.** The first user-facing specialist is the SNS / Viral Marketing Persona; coding remains a first-class internal capability for automation and self-improvement.

## Design Principles

- **Environment over agent.** When an agent fails, the harness is broken — not the prompt. Fix the system that surrounds the agent.
- **Human intervention is a system gap.** Every time you step in, that's a defect signal. The system should learn from it and close the gap.
- **Constraints enable speed.** Strict architectural rules don't slow agents down — they eliminate drift. More structure means faster autonomous work.
- **Progressive disclosure.** Don't dump everything into context. Give agents a map. They find detail when they need it.
- **Authority is hierarchical.** The user and Main Persona can create new inbound work; ordinary Sub Personas cannot recursively spawn top-level work unless explicitly trusted.

## Architecture

TypeScript monorepo powered by [Bun](https://bun.sh) and [Turborepo](https://turborepo.dev).

```
openomni/
├── apps/
│   ├── cli/             # CLI entry point (auth + config)
│   └── server/          # Hono server with Discord / Telegram / GitHub / WebSocket channels
├── packages/
│   ├── protocol/        # Shared Zod schemas (20 domains — message, tool, run, event, plan, subagent, hook, …)
│   ├── session/         # Session CRUD, pub/sub bus, storage adapters, event log, worker runs
│   ├── llm/             # LLM abstraction (providers, auth, streaming, retry, token tracking)
│   ├── agent/           # ChatAgent core (middleware-driven ReAct loop) + multi-agent runtime (messenger, MCP, subagent tools) — no session state ownership
│   ├── openomni/        # Orchestration (Plan mode, DAG, Ingress, SubagentRuntime, BackgroundManager, BusTransport, execution runtime)
│   └── coordinator/     # Multiprocess execution coordinator (worker pool, IPC, recovery, credentials, tool-permission)
```

### Dependency Graph

```
protocol ← session ← llm ← agent ← openomni ← coordinator ← { cli, server }
```

Each package depends only on packages to its left. `protocol` is the leaf with zero internal dependencies. `agent` owns execution behavior, not durable session state; sanctioned observability primitives may come from `session`. `cli` and `server` are sibling apps.

### Product Direction

See [Persona Workforce Direction](docs/persona-workforce.md) and [ADR-005](docs/design-decisions/005-persona-workforce-runtime.md) for the Main Persona, Sub Persona, controlled inbound authority, self-loop session, and first-domain strategy.

### Execution Modes

Ingress supports two modes:

- **`direct`** — default. Dispatches the request through the coordinator seam to run a persona against session history and return the response.
- **`plan`** — triggered by a `/plan` prefix. Runs `PlanAgent.create()` with plan tools to produce a plan stored in `Storage.PlanSubAdapter`.

## Getting Started

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun test

# Type check
bun run check-types

# Format
bun run format
```

## License

MIT
