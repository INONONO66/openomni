# OpenOmni

**Orchestration layer for autonomous multi-agent work.**

> ⚠️ This project is under active development.

## Why

Working with AI agents today means sitting at a terminal — run a task, wait, intervene, re-run, wait again. Every session starts from scratch. Agents forget past decisions, repeat mistakes, rediscover conventions you taught them yesterday.

When you want the same agent patterns applied to a different domain — research instead of coding, analysis instead of writing — you rebuild everything. Even though 90% of the infrastructure is identical.

OpenOmni exists to end this cycle. One infrastructure layer that handles orchestration, memory, and tool management for any domain. Send a task from anywhere. Get results back. The system handles the rest.

## What

OpenOmni is an orchestration layer, not a chatbot framework.

- **One layer, all domains.** Coding, research, analysis — same infrastructure. Only the agent prompt changes.
- **Self-orchestrating.** Give it one goal. It decomposes the work, delegates to specialized agents, executes in parallel, and delivers results.
- **Self-improving.** Agents accumulate knowledge across sessions through [Anamnesis](https://github.com/inonono66/anamnesis), an associative cognitive graph engine. Mistakes don't repeat. Conventions persist. Decisions carry their reasoning.

## Design Principles

- **Environment over agent.** When an agent fails, the harness is broken — not the prompt. Fix the system that surrounds the agent.
- **Human intervention is a system gap.** Every time you step in, that's a defect signal. The system should learn from it and close the gap.
- **Constraints enable speed.** Strict architectural rules don't slow agents down — they eliminate drift. More structure means faster autonomous work.
- **Progressive disclosure.** Don't dump everything into context. Give agents a map. They find detail when they need it.

## Architecture

TypeScript monorepo powered by [Bun](https://bun.sh) and [Turborepo](https://turborepo.dev).

```
openomni/
├── apps/cli/            # CLI entry point
├── packages/
│   ├── protocol/        # Shared Zod schemas (Message, Tool, Run, Events)
│   ├── session/         # Session CRUD, pub/sub bus, storage adapters
│   ├── llm/             # LLM abstraction (providers, OAuth, streaming, retry)
│   ├── agent/           # Stateless ChatAgent — pure ReAct loop
│   └── openomni/        # Orchestration (Plan/Team mode, DAG, task lifecycle)
```

### Dependency Graph

```
protocol  ←  session  ←  llm  ←  agent  ←  openomni  ←  cli
```

Each package depends only on packages to its left. `protocol` is the leaf with zero internal dependencies.

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
