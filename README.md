# OpenOmni

Multi-agent task orchestration framework for LLM-powered autonomous agents.

## Architecture

TypeScript monorepo powered by [Bun](https://bun.sh) and [Turborepo](https://turborepo.dev).

```
openomni/
├── apps/cli/            # CLI entry point
├── packages/
│   ├── protocol/        # Shared Zod schemas (Message, Tool, Run, Events)
│   ├── session/         # Session CRUD, pub/sub bus, storage adapters
│   ├── llm/             # LLM abstraction (providers, OAuth, streaming, retry)
│   └── agent/           # Core orchestration (task lifecycle, agent graph, triggers)
```

### Dependency Graph

```
protocol  <-  session  <-  llm  <-  agent  <-  cli
```

`protocol` is the leaf with zero internal dependencies. Each layer builds on the one before it.

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
