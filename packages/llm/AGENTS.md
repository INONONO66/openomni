# packages/llm

LLM provider abstraction. Handles auth (API key + proxy), provider SDK wiring, streaming, retry, message conversion, token usage accounting, and the `run()` entry point. Depends on `@openomni/protocol` only. It reports what it did through an injected `BusEvent.Sink`, so it imports no implementation of the observation channel and nothing durable (#606).

## STRUCTURE

```
src/
├── index.ts          # Narrow public API: Auth, Provider, ModelsDev, errors, run, RunInput, TokenTracker
├── run.ts            # run() — model-required top-level entry: messages+tools → Run.Outcome via Sink
├── error.ts          # ProviderError + NamedError/APIError re-exports + coerceApiError (AI SDK error → APIError)
├── message/
│   └── index.ts      # toModelMessages() — Message.WithParts[] → AI SDK messages
├── processor/
│   ├── index.ts      # Processor.create() — bounded retry loop, sink projection through the injected events port, status snapshots
│   └── stream-events.ts # Stream event projection: text/reasoning/tool/step parts + interruption cleanup
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
└── model/
    ├── index.ts      # ModelsDev.get / refresh — fetches models.dev catalog (lazy helper inlined here)
    └── models-snapshot.json # Bundled trusted catalog snapshot — the weekly workflow regenerates THIS file (#471)
```

## KEY PATTERNS

- **Narrow root public API**: `src/index.ts` intentionally exports only `Auth`, `Provider`, `ModelsDev`, LLM error classes, `run`, `RunInput`, and `TokenTracker`. Do not add session/protocol helpers, `ProviderTransform`, `fetchProxyModels`, `enrichWithCatalog`, `Processor`, `Retry`, `Message`, `Tool`, or `toModelMessages` back to the root barrel. Use deep imports inside `packages/llm` tests/internal code when those helpers are needed.
- **`run()` entry point**: Takes `RunInput` (messages, tools, required model, required `trace` and `events`, optional auth, system, toolExecutor, toolChoice, maxSteps, providerOptions), drives a Processor loop, and returns `Run.Outcome` via the injected `Sink`. `RunInput.model` is required; do not reintroduce model-less/noop fallback behavior in `run()`.
- **Provider.Model**: Zod schema with capabilities, cost, limits, status. Built from `models.dev` data via `Provider.fromModelsDevModel()`. `Provider.listModels()` / `listProviders()` / `getProviderInfo()` surface catalog lookups.
- **Auth.Info** (discriminated union): `{ type: "api", key }` | `{ type: "proxy", baseURL, apiKey? }`. Stored via `Auth.set(providerId, info)` and read by `getSDK()` before each call.
- **SDK wiring** (`provider/sdk.ts`): `getSDK(model, auth)` resolves to Anthropic / OpenAI. Custom OpenAI-compatible endpoints use `@ai-sdk/openai` with `baseURL` / `name`, keeping returned language models on the same AI SDK provider type version. SDK and `LanguageModel` instances are cached per `providerID:npm:modelID:auth` key. Provider-specific behavior belongs in `provider/`, `auth/`, or `transform/`, not in call sites.
- **Provider transforms** (`provider/transform.ts`): `normalizeMessages()` filters empty blocks, sanitizes tool-call IDs, applies Anthropic ephemeral caching to the last two user/assistant messages. This is an internal/deep import surface, not a root export.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, trace, events, sink?, createStream, maxRetryAttempts? })`. `trace` and `events` are required: a record filed without a trace names nothing, and `events` is where every record goes. `process({ system })` resolves on stream completion and throws on abort/terminal error; `run()` maps that to `Run.Outcome` and publishes `LlmCall.Completed` on success or `LlmCall.Failed` (with `aborted`) otherwise — every `Started` gets a terminal event. Parts are published **copy-on-write**: a published part object is never mutated afterwards, so sink consumers may hold snapshots; text/reasoning parts carry the accumulated text on every delta. Tool parts go `running` (with `time.start`) at `tool-call` and close with a real duration at `tool-result`. Processor owns `tool-call`/`tool-result` stream projection; tool *execution* happens only in `run()`'s AI SDK `execute` callback, which must not directly emit tool sink events. Status snapshots are `busy` → (`retry`…) → `idle`, exactly one `idle` per process() call.
- **Retry**: raw AI SDK errors (`AI_APICallError`) must pass through `coerceApiError` before classification — their retry fields live on the error object, not under `.data`, and never match `APIError.isInstance`. `Retry.isRetryable` classifies by payload sniffing (message, then responseBody), then statusCode (429 / ≥500), then trusts the provider `isRetryable` flag. `Retry.delay(attempt, error?)` respects `retry-after` / `retry-after-ms` headers; fallback backoff is capped at 30s whether or not headers are present. Processor retrying is finite by default; do not use unbounded retry loops or publish `Number.MAX_SAFE_INTEGER` as a retry cap.
- **TokenTracker**: Extracts token usage from AI SDK/provider responses. Runtime accounting stores token counts on the assistant message, keyed by that message's provider/model identity. The llm package does not calculate dollar cost.
- **ModelsDev**: Lazy-loads the catalog from `models.dev` into a local cache, falls back to a bundled snapshot. Respects `OPENOMNI_MODELS_URL`, `OPENOMNI_MODELS_PATH`, `OPENOMNI_DISABLE_MODELS_FETCH`. Remote/cache catalog data is untrusted: only providers backed by bundled AI SDK packages are exposed, provider `api` URLs are stripped, and model-level provider overrides are stripped before caching/returning.
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Custom OpenAI-compatible endpoints must come from explicit `Provider.Model` config, trusted bundled snapshot data, or proxy auth.

## ANTI-PATTERNS

- Do NOT import `Bus` here. `llm` reports through the `events` port it is handed; reaching for the process-wide bus re-couples the package to an implementation the composition root is supposed to choose (#606). `check-deps`' source scan is what keeps `src/` clean.
- `packages/llm` sets `noEmit: true` in tsconfig — it does NOT produce a `dist/`. It is consumed as source by Bun.
- Do NOT add provider-specific logic to call sites. Keep SDK wiring in `provider/`, credential handling in `auth/`, and message/request shaping in `transform/`.
- Do NOT bypass `Auth.get()` for credentials (e.g. reading env vars inline). All credentials flow through the namespace.
- Do NOT hand-craft provider-specific request rewriting at call sites — keep it behind provider or transform modules so it stays in one place.
