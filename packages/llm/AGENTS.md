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
- **SDK wiring**: `getSDK(model, auth)` resolves to Anthropic / OpenAI / OpenAI-compatible. SDK and `LanguageModel` instances are cached per `providerID:npm:modelID:auth` key. Provider-specific behavior belongs in `provider/`, `auth/`, or `transform/`, not in call sites.
- **Provider transforms** (`transform/index.ts`): `normalizeMessages()` filters empty blocks, sanitizes tool-call IDs, applies Anthropic ephemeral caching to the last two user/assistant messages. `variants(model)` exposes per-provider thinking / reasoning presets; `resolveVariant(model, variant?)` picks one.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, sink, onToolCall, createStream })`. `process()` returns `"stop" | "continue" | "compact"`. Accumulates `TextPart` / `ReasoningPart` / `ToolPart` and publishes through `Sink`.
- **Retry**: `Retry.delay(attempt, error?)` computes backoff respecting `retry-after` / `retry-after-ms` headers. `Retry.isRetryable(error)` checks `APIError.isRetryable`.
- **TokenTracker**: Extracts usage from provider responses and calculates cost against the bundled pricing map. Unknown models return zero cost with a warning.
- **ModelsDev**: Lazy-loads the catalog from `models.dev` into a local cache, falls back to a bundled snapshot. Respects `OPENOMNI_MODELS_URL`, `OPENOMNI_MODELS_PATH`, `OPENOMNI_DISABLE_MODELS_FETCH`.
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Everything else goes through `@ai-sdk/openai-compatible` configured with `baseURL`.

## ANTI-PATTERNS

- `packages/llm` sets `noEmit: true` in tsconfig — it does NOT produce a `dist/`. It is consumed as source by Bun.
- Do NOT add provider-specific logic to call sites. Keep SDK wiring in `provider/`, credential handling in `auth/`, and message/request shaping in `transform/`.
- Do NOT bypass `Auth.get()` for credentials (e.g. reading env vars inline). All credentials flow through the namespace.
- Do NOT hand-craft provider-specific request rewriting at call sites — keep it behind provider or transform modules so it stays in one place.
