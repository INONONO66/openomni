# packages/llm

LLM provider abstraction layer. Handles auth (API key + OAuth), provider SDK wiring, streaming, retry, message conversion, and the `run()` entry point. Depends on `@openomni/protocol` and `@openomni/session`.

## STRUCTURE

```
src/
├── index.ts          # Public API re-exports
├── run.ts            # run() — top-level entry: messages+tools → RunOutcome via Sink
├── error.ts          # Re-exports NamedError classes from protocol
├── session/
│   ├── processor.ts  # Processor.create() — drives LLM call, handles steps
│   ├── message.ts    # Message handling utilities
│   ├── convert.ts    # toModelMessages() — protocol messages → AI SDK format
│   ├── llm.ts        # Stream — low-level streaming wrapper
│   ├── tool.ts       # Tool execution within session context
│   └── retry.ts      # Retry logic with exponential backoff
├── auth/
│   ├── storage.ts    # Auth namespace: get/set/remove/all credential storage
│   └── registry.ts   # Provider auth registry (OAuth + API key methods)
├── provider/
│   ├── index.ts      # Provider namespace, listModels(), listProviders(), getSDK()
│   └── provider.ts   # getSDK() — maps model to @ai-sdk/* SDK instance
├── oauth/
│   ├── pkce.ts       # PKCE code challenge generation
│   ├── anthropic.ts  # Anthropic OAuth flow
│   └── openai.ts     # OpenAI OAuth flow
├── fetch/
│   ├── anthropic.ts  # createOAuthFetch() — custom fetch with OAuth token injection
│   └── openai.ts     # OpenAI custom fetch
├── model/
│   └── index.ts      # ModelsDev.get() — fetches model catalog from models.dev
├── transform/
│   └── index.ts      # ProviderTransform — pre/post transform hooks
└── util/
    └── lazy.ts       # Lazy initialization helper
```

## KEY PATTERNS

- **Provider.Model schema**: Rich Zod schema with capabilities, cost, limits. Built from models.dev data via `Provider.fromModelsDevModel()`.
- **Auth.Info**: Discriminated `{ type: "api", key } | { type: "oauth", ... }`. Stored via `Auth.set(providerId, info)`.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, sink })`. Calls `process()` which returns `"stop" | "continue" | "compact"`.
- **run()**: Wraps Processor. Input = messages + tools + system. Output = RunOutcome (stop/await_tool/aborted/error).
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Others via `@ai-sdk/openai-compatible`.
- **OAuth flows**: Provider-specific in `oauth/`. Each exports a function registered in `auth/registry.ts`.

## ANTI-PATTERNS

- `packages/llm` has `noEmit: true` in tsconfig — it does NOT produce `dist/`. Consumed via source by Bun.
- Do NOT add provider-specific logic outside `fetch/` and `oauth/` — keep `session/` and `provider/` generic.
