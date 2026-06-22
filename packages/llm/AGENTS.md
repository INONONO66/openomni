# packages/llm

LLM provider abstraction. Handles auth (API key + proxy), provider SDK wiring, streaming, retry, message conversion, token usage accounting, and the `run()` entry point. Depends on `@openomni/protocol` and `@openomni/session`.

## STRUCTURE

```
src/
├── index.ts          # Narrow public API: Auth, Provider, ModelsDev, errors, run, RunInput, TokenTracker
├── run.ts            # run() — model-required top-level entry: messages+tools → Run.Outcome via Sink
├── error.ts          # Re-exports NamedError classes from protocol
├── message/
│   └── index.ts      # toModelMessages() — Message.WithParts[] → AI SDK messages
├── processor/
│   ├── index.ts      # Processor.create() orchestrator — bounded retry loop + stream driving
│   ├── stream-events.ts # Stream event dispatch for text/reasoning/tool/step events
│   ├── sink-projection.ts # Sink projection to Bus telemetry + noop sink
│   ├── step-accounting.ts # step-start / step-finish token accounting
│   ├── tool-projection.ts # tool-call/tool-result projection, optional execution, interruption cleanup
│   └── contracts.ts  # Internal Processor implementation contracts
├── retry/
│   └── index.ts      # Retry.delay / sleep / isRetryable — exponential backoff + retry-after
├── auth/
│   ├── storage.ts    # Auth namespace: get / set / remove / all (credential storage)
├── provider/
│   ├── index.ts      # Provider + ModelsDev public namespaces; internal provider helpers stay deep
│   ├── sdk.ts        # getSDK() + getLanguage() — maps Provider.Model to @ai-sdk/* instance
│   ├── transform.ts  # ProviderTransform — message normalization, caching, per-provider variants
│   └── proxy-models.ts # Proxy model catalog fetch/enrichment
├── token/
│   └── index.ts      # TokenTracker.extractUsage
├── model/
│   ├── index.ts      # ModelsDev.get / refresh — fetches models.dev catalog
│   └── models-snapshot.json # Bundled trusted catalog snapshot
└── util/
    └── lazy.ts       # Lazy initialization helper
```

## KEY PATTERNS

- **Narrow root public API**: `src/index.ts` intentionally exports only `Auth`, `Provider`, `ModelsDev`, LLM error classes, `run`, `RunInput`, and `TokenTracker`. Do not add session/protocol helpers, `ProviderTransform`, `fetchProxyModels`, `enrichWithCatalog`, `Processor`, `Retry`, `Message`, `Tool`, or `toModelMessages` back to the root barrel. Use deep imports inside `packages/llm` tests/internal code when those helpers are needed.
- **`run()` entry point**: Takes `RunInput` (messages, tools, required model, optional auth, system, toolExecutor, toolChoice, maxSteps, providerOptions), drives a Processor loop, and returns `Run.Outcome` via the injected `Sink`. `RunInput.model` is required; do not reintroduce model-less/noop fallback behavior in `run()`.
- **Provider.Model**: Zod schema with capabilities, cost, limits, status. Built from `models.dev` data via `Provider.fromModelsDevModel()`. `Provider.listModels()` / `listProviders()` / `getProviderInfo()` surface catalog lookups.
- **Auth.Info** (discriminated union): `{ type: "api", key }` | `{ type: "proxy", baseURL, apiKey? }`. Stored via `Auth.set(providerId, info)` and read by `getSDK()` before each call.
- **SDK wiring** (`provider/sdk.ts`): `getSDK(model, auth)` resolves to Anthropic / OpenAI. Custom OpenAI-compatible endpoints use `@ai-sdk/openai` with `baseURL` / `name`, keeping returned language models on the same AI SDK provider type version. SDK and `LanguageModel` instances are cached per `providerID:npm:modelID:auth` key. Provider-specific behavior belongs in `provider/`, `auth/`, or `transform/`, not in call sites.
- **Provider transforms** (`provider/transform.ts`): `normalizeMessages()` filters empty blocks, sanitizes tool-call IDs, applies Anthropic ephemeral caching to the last two user/assistant messages. `variants(model)` exposes per-provider thinking / reasoning presets; `resolveVariant(model, variant?)` picks one. This is an internal/deep import surface, not a root export.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, sink, onToolCall, createStream, maxRetryAttempts? })`. `process()` returns `"stop" | "continue" | "compact"`. Accumulates `TextPart` / `ReasoningPart` / `ToolPart` and publishes through `Sink`. Processor owns `tool-call` and `tool-result` stream projection; `run()`'s AI SDK `execute` callback must not directly emit tool sink events.
- **Retry**: `Retry.delay(attempt, error?)` computes backoff respecting `retry-after` / `retry-after-ms` headers. `Retry.isRetryable(error)` checks `APIError.isRetryable`. Processor retrying is finite by default; do not use unbounded retry loops or publish `Number.MAX_SAFE_INTEGER` as a retry cap.
- **TokenTracker**: Extracts token usage from AI SDK/provider responses. Runtime accounting stores token counts on the assistant message, keyed by that message's provider/model identity. The llm package does not calculate dollar cost.
- **ModelsDev**: Lazy-loads the catalog from `models.dev` into a local cache, falls back to a bundled snapshot. Respects `OPENOMNI_MODELS_URL`, `OPENOMNI_MODELS_PATH`, `OPENOMNI_DISABLE_MODELS_FETCH`. Remote/cache catalog data is untrusted: only providers backed by bundled AI SDK packages are exposed, provider `api` URLs are stripped, and model-level provider overrides are stripped before caching/returning.
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Custom OpenAI-compatible endpoints must come from explicit `Provider.Model` config, trusted bundled snapshot data, or proxy auth.

## ANTI-PATTERNS

- `packages/llm` sets `noEmit: true` in tsconfig — it does NOT produce a `dist/`. It is consumed as source by Bun.
- Do NOT add provider-specific logic to call sites. Keep SDK wiring in `provider/`, credential handling in `auth/`, and message/request shaping in `transform/`.
- Do NOT bypass `Auth.get()` for credentials (e.g. reading env vars inline). All credentials flow through the namespace.
- Do NOT hand-craft provider-specific request rewriting at call sites — keep it behind provider or transform modules so it stays in one place.
