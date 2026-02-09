# apps/cli

CLI entry point for OpenOmni. Yargs for command routing, @clack/prompts for interactive UI.

## STRUCTURE

```
src/
├── index.ts       # Yargs bootstrap, registers commands
└── cmd/
    ├── auth.ts    # auth login|logout|list — credential management
    └── agent.ts   # agent --mode direct|orchestrated — test agent execution
```

## KEY PATTERNS

- **Command structure**: Each file exports a `CommandModule` from yargs. Registered in `index.ts` via `.command()`.
- **Auth flow**: `auth login` → select provider → select method (OAuth or API key) → store via `Auth.set()`.
- **Agent modes**: `direct` uses `streamText()` directly. `orchestrated` uses full `Orchestrator.run()` pipeline with TaskManager, AgentRegistry, session.
- **cancel() helper**: Wraps `@clack/prompts` cancel detection → `process.exit(0)`.

## ANTI-PATTERNS

- Imports reach into package internals (e.g., `@openomni/llm/src/auth/storage` instead of `@openomni/llm`). Known tech debt.
- `agent.ts` has hardcoded model ID (`claude-sonnet-4-20250514`) and fake tools. This is a demo/test command.

## COMMANDS

```bash
bun run --cwd apps/cli dev             # Run CLI in dev mode
openomni auth login                    # Add credential
openomni auth logout                   # Remove credential
openomni auth list                     # List credentials
openomni agent                         # Run direct mode
openomni agent --mode orchestrated     # Run full pipeline
openomni agent -m "your query"         # Custom query
```
