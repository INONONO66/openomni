# Contributing

OpenOmni is a personal AI workforce project with a specific architectural vision. Contributions are welcome, but please read through `docs/` before proposing significant changes. The project prioritizes coherence over feature count.

## Prerequisites

- [Bun](https://bun.sh) 1.x
- Node.js 22+
- TypeScript (installed via Bun)

## Setup

```bash
git clone https://github.com/openomni/openomni.git
cd openomni
bun install
bun run build
bun test
```

## Development Commands

| Command | Description |
|---|---|
| `bun install` | Install dependencies |
| `bun run build` | Build all packages |
| `bun test` | Run tests |
| `bun run check-types` | Type check |
| `bun run format` | Format with Biome |
| `bun run script/check-deps.ts` | Check package boundary violations |

## Code Style

Formatting and linting via [Biome](https://biomejs.dev). TypeScript strict mode throughout. Cross-package contracts use Zod-first types. Public APIs follow the namespace pattern (`Session.create()`, not named exports). See `docs/architecture.md` (Code Conventions) for the rationale behind these choices.

## Commit Messages

Conventional commits: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`

Scope is the package name (`protocol`, `session`, `llm`, `agent`, `openomni`, `coordinator`). Keep descriptions imperative and under 72 characters.

## Architecture

TypeScript monorepo built with Bun and Turborepo. The dependency graph is strictly layered:

```
protocol ← session ← llm ← agent ← openomni ← coordinator ← server
```

Each package depends only on packages to its left. Cross-layer shortcuts are not accepted. See `docs/architecture.md` for the full architecture rationale.

## License

MIT. By contributing, you agree your contributions will be licensed under the same [MIT License](LICENSE).
