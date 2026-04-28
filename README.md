# OpenOmni

**Personal AI workforce infrastructure.**

> ⚠️ This project is under active development.

OpenOmni is a runtime for managing AI personas as a personal workforce. The user talks primarily to one Main Persona. That Main Persona understands the user's goals, decides what should be handled directly, delegates specialized work to Sub Personas, and keeps the original user-facing session clean by isolating complex internal work in separate sessions.

## Product Model

```txt
User
  ↕
Main Persona
  ├─ SNS / Viral Marketing Persona
  ├─ Coding Persona
  ├─ Research Persona
  ├─ Reviewer Persona
  └─ Future domain personas
```

The Main Persona is the relationship owner and workforce manager. Sub Personas are specialized workers. The user may target a specific persona directly, but ordinary Sub Personas cannot recursively create new top-level inbound work unless they are explicitly trusted as manager personas.

The first user-facing domain is SNS and viral marketing. Coding remains a first-class internal capability because the system must build automations, improve tooling, and maintain itself.

## Core Runtime Ideas

### Main Persona as the default interface

The user should not need to pick the right worker for every request. The Main Persona receives the request, decides whether it is simple or complex, chooses the right execution layer, and reports back with the distilled result.

### Controlled inbound authority

OpenOmni treats inbound work as an authority boundary.

```txt
External inbound
  User / surface / API → IngressEngine → target persona

Internal inbound
  Main Persona → inbound.submit → IngressEngine → new work item
```

The user and Main Persona can create new inbound work. Normal Sub Personas return results and suggestions, but they cannot create new top-level work by default. This prevents unmanaged recursive task growth.

### Three-layer execution

| Layer | Name | Used when | Session behavior |
| --- | --- | --- | --- |
| 1 | Direct | The Main Persona can answer or act directly | Original session only |
| 2 | Delegate | A specialized Sub Persona should handle the task | Child persona session |
| 3 | Fork | The task needs deeper reasoning, planning, or multi-persona coordination | Isolated self-loop session |

Layer 3 is not just a background job. It is a separate internal work session where the request can be restated, refined, debated, delegated, reviewed, and then written back as a clean result.

### Session hygiene

The original user session is the relationship and decision record. Internal thinking, failed attempts, worker transcripts, and experiments belong in child or self-loop sessions. This keeps the Main Persona's user-facing context readable and auditable.

### Persona lifecycle

Sub Personas can start as temporary workers. If a worker is repeatedly useful, its role can become a persistent persona.

```txt
ephemeral worker
  → repeated useful work
  → persona candidate
  → evaluation
  → approval or policy acceptance
  → persistent persona
```

This lets OpenOmni grow a useful workforce without making every generated worker permanent.

### Memory-ready design

OpenOmni is designed to be integrated with [Anamnesis](https://github.com/inonono66/anamnesis), an associative cognitive graph engine. OpenOmni should provide session lineage, provenance, worker records, and memory candidates. Anamnesis can later decide how verified experience becomes long-term memory.

Raw chat history is not treated as behavioral memory by default. Durable memory should be scoped, attributed, and reviewable.

## System Architecture

OpenOmni is a TypeScript monorepo powered by [Bun](https://bun.sh) and [Turborepo](https://turborepo.dev).

```txt
openomni/
├── apps/
│   ├── cli/             # CLI entry point (auth + config)
│   └── server/          # Hono server with Discord / Telegram / GitHub / WebSocket channels
├── packages/
│   ├── protocol/        # Shared Zod schemas and cross-package contracts
│   ├── session/         # Sessions, messages, storage, bus, event log, worker runs
│   ├── llm/             # Model providers, auth, streaming, retry, token/cost tracking
│   ├── agent/           # Stateless ChatAgent primitive, middleware, messenger, registry, tools, MCP
│   ├── openomni/        # Ingress, plan mode, DAG, subagent runtime, background manager, execution runtime
│   └── coordinator/     # Worker pool, IPC, recovery, credentials, tool-permission policy
```

### Dependency graph

```txt
protocol ← session ← llm ← agent ← openomni ← coordinator ← { cli, server }
```

Each package depends only on packages to its left. `protocol` is the leaf with zero internal dependencies. `agent` owns execution behavior, not durable session state; sanctioned observability primitives may come from `session`. Session-backed orchestration belongs in `openomni`.

### Runtime path

```txt
Surface event
  → IngressEngine
  → SurfaceKey / Session resolution
  → message projection
  → CoordinatorLike.dispatch
  → worker execution runtime
  → ChatAgent / PlanAgent / SubagentRuntime
  → result integration
```

Ingress currently supports two execution modes:

- **`direct`** — dispatches a persona run against session history and returns the response.
- **`plan`** — runs `PlanAgent.create()` with plan tools and stores a `{ planId }` reference in `Storage.PlanSubAdapter`.

## Documentation Map

- [Persona Workforce Direction](docs/persona-workforce.md) — product model, runtime concepts, persona lifecycle, and gaps.
- [Persona Runtime Roadmap](docs/persona-runtime-roadmap.md) — staged implementation path for authority, self-loop sessions, persona lifecycle, SNS, and memory readiness.
- [ADR-005](docs/design-decisions/005-persona-workforce-runtime.md) — accepted decision for the persona workforce runtime direction.
- [Golden Principles](docs/golden-principles.md) — package boundaries, dependency direction, and coding invariants.
- [Observability Doctrine](docs/observability-doctrine.md) — Log, Bus, Telemetry, trace context, and sensitive data policy.
- [Quality Score](docs/quality-score.md) — package quality status and known technical debt.

## Development

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bun test

# Type check
bun run check-types

# Check package boundaries and golden principles
bun run script/check-deps.ts

# Format
bun run format
```

## License

MIT
