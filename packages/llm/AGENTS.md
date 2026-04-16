# packages/llm

LLM provider abstraction. Handles auth (API key + OAuth), provider SDK wiring, streaming, retry, message conversion, token/cost tracking, and the `run()` entry point. Depends on `@openomni/protocol` and `@openomni/session`.

## STRUCTURE

```
src/
├── index.ts          # Public API re-exports
├── run.ts            # run() — top-level entry: messages+tools → Run.Outcome via Sink
├── error.ts          # Re-exports NamedError classes from protocol
├── session/
│   ├── processor.ts  # Processor.create() — drives streaming LLM call + tool turns
│   ├── message.ts    # Message namespace helpers
│   ├── convert.ts    # toModelMessages() — Message.WithParts[] → AI SDK messages
│   ├── tool.ts       # Tool namespace helpers (execution within session context)
│   └── retry.ts      # Retry.delay / sleep / isRetryable — exponential backoff + retry-after
├── auth/
│   ├── storage.ts    # Auth namespace: get / set / remove / all (credential storage)
│   └── registry.ts   # Provider auth registry (OAuth methods + API key paths)
├── provider/
│   ├── index.ts      # Provider + ProviderTransform + ModelsDev namespaces
│   └── provider.ts   # getSDK() + getLanguage() — maps Provider.Model to @ai-sdk/* instance
├── oauth/
│   ├── pkce.ts               # PKCE challenge/verifier helpers
│   ├── anthropic.ts          # Anthropic OAuth flow (authorize / exchange / refresh)
│   ├── openai.ts             # OpenAI OAuth flow (device auth, JWT parsing)
│   └── callback-parser.ts    # Shared callback URL parsing
├── fetch/
│   ├── anthropic.ts          # createAnthropicOAuthFetch() — token refresh + request rewriting
│   ├── anthropic-transform.ts# Provider-specific request body / header transforms for Anthropic OAuth
│   └── openai.ts             # createOpenAIOAuthFetch()
├── transform/
│   └── index.ts      # ProviderTransform — message normalization, caching, per-provider variants
├── token/
│   └── index.ts      # TokenTracker.extractUsage + calculateCost
├── agent/
│   └── index.ts      # Agent.Info schema + defaults (lightweight agent profile)
├── model/
│   └── index.ts      # ModelsDev.get / refresh / init — fetches models.dev catalog
└── util/
    └── lazy.ts       # Lazy initialization helper
```

## KEY PATTERNS

- **`run()` entry point**: Takes `RunInput` (messages, tools, system, model, toolExecutor, toolChoice, maxSteps, providerOptions), drives a Processor loop, and returns `Run.Outcome` via the injected `Sink`.
- **Provider.Model**: Zod schema with capabilities, cost, limits, status. Built from `models.dev` data via `Provider.fromModelsDevModel()`. `Provider.listModels()` / `listProviders()` / `getProviderInfo()` surface catalog lookups.
- **Auth.Info** (discriminated union): `{ type: "api", key }` | `{ type: "oauth", access, refresh, expires, accountId? }` | `{ type: "proxy", baseURL, apiKey? }`. Stored via `Auth.set(providerId, info)` and read by `getSDK()` before each call.
- **SDK wiring**: `getSDK(model, auth)` resolves to Anthropic / OpenAI / OpenAI-compatible. When `auth.type === "oauth"`, requests go through `createAnthropicOAuthFetch` / `createOpenAIOAuthFetch` which refresh tokens on expiry and apply provider-specific request rewriting. SDK and `LanguageModel` instances are cached per `providerID:npm:modelID:auth` key.
- **Provider transforms** (`transform/index.ts`): `normalizeMessages()` filters empty blocks, sanitizes tool-call IDs, applies Anthropic ephemeral caching to the last two user/assistant messages. `variants(model)` exposes per-provider thinking / reasoning presets; `resolveVariant(model, variant?)` picks one.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, sink, onToolCall, createStream })`. `process()` returns `"stop" | "continue" | "compact"`. Accumulates `TextPart` / `ReasoningPart` / `ToolPart` and publishes through `Sink`.
- **Retry**: `Retry.delay(attempt, error?)` computes backoff respecting `retry-after` / `retry-after-ms` headers. `Retry.isRetryable(error)` checks `APIError.isRetryable`.
- **TokenTracker**: Extracts usage from provider responses and calculates cost against the bundled pricing map. Unknown models return zero cost with a warning.
- **ModelsDev**: Lazy-loads the catalog from `models.dev` into a local cache, falls back to a bundled snapshot. Respects `OPENOMNI_MODELS_URL`, `OPENOMNI_MODELS_PATH`, `OPENOMNI_DISABLE_MODELS_FETCH`.
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Everything else goes through `@ai-sdk/openai-compatible` configured with `baseURL`.

## ANTI-PATTERNS

- `packages/llm` sets `noEmit: true` in tsconfig — it does NOT produce a `dist/`. It is consumed as source by Bun.
- Do NOT add provider-specific logic outside `fetch/`, `oauth/`, and `provider/provider.ts` — keep `session/`, `transform/`, and `token/` generic.
- Do NOT bypass `Auth.get()` for credentials (e.g. reading env vars inline). All credentials flow through the namespace.
- Do NOT hand-craft provider-specific request rewriting at call sites — put it behind the per-provider fetch wrapper so it stays in one place.
