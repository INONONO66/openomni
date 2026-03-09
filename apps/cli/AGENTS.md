# apps/cli

CLI entry point for OpenOmni. Built with yargs + @clack/prompts.

## STRUCTURE

```
src/
├── index.ts          # CLI entry — yargs command registration
├── cmd/
│   ├── auth.ts       # `openomni auth login/logout/list` — credential management
│   ├── config.ts     # `openomni config` — adapter configuration (add/list/remove)
│   └── serve.ts      # `openomni serve` — start adapter-based server
├── adapter/
│   ├── types.ts      # Adapter.Surface interface + Adapter namespace
│   ├── telegram.ts   # Telegram Bot API adapter
│   ├── github.ts     # GitHub webhooks adapter
│   └── discord.ts    # Discord bot adapter
├── serve/
│   ├── conversation.ts  # Conversation state management
│   ├── surface-store.ts # Surface key → session mapping
│   ├── trigger.ts       # Event trigger wiring
│   ├── dedupe.ts        # Message deduplication
│   └── utils.ts         # Serve utilities (tech debt — catch-all filename)
└── config/              # Runtime configuration
```

## HOW TO ADD

### New Command

1. Create `src/cmd/{name}.ts`
2. Export a yargs `CommandModule`
3. Register in `src/index.ts`

### New Adapter

1. Create `src/adapter/{name}.ts`
2. Implement `Adapter.Surface` interface from `src/adapter/types.ts`
3. Wire into `src/cmd/serve.ts`

## ANTI-PATTERNS

- **Deep imports**: `auth.ts` imports `@openomni/llm/src/auth/registry` and `@openomni/llm/src/auth/storage` directly instead of through the package barrel. This is tracked tech debt — do NOT extend. Use `@openomni/llm` barrel for new code.
- **`serve/utils.ts`**: Catch-all filename. New utilities should go in purpose-named files.

## KNOWN TECH DEBT

- Zero test files — no test coverage at all
- Adapters are demo/prototype quality — not production-ready
- Adapters are demo/prototype quality — not production-ready
- Deep imports into `@openomni/llm` internals (2 violations)
