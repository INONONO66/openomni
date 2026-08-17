# packages/llm

LLM provider abstraction. Handles auth (API key + proxy), provider SDK wiring, streaming, retry, message conversion, token usage accounting, and the `run()` entry point. Depends on `@openomni/protocol` only. It reports what it did through an injected `BusEvent.Sink`, so it imports no implementation of the observation channel and nothing durable (#606).

## STRUCTURE

```
src/
├── index.ts          # Narrow public API: Auth, Provider, ModelsDev, errors, run, RunInput
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
│   ├── storage.ts    # Auth namespace: get / set / all (credential storage)
├── provider/
│   ├── index.ts      # Provider + ModelsDev public namespaces; internal provider helpers stay deep
│   ├── sdk.ts        # getSDK() + getLanguage() — maps Provider.Model to @ai-sdk/* instance
│   ├── transform.ts  # ProviderTransform — message normalization, caching, per-provider variants
│   └── proxy-models.ts # Proxy model catalog fetch/enrichment
├── token/
│   └── index.ts      # TokenTracker.extractUsage
└── model/
    ├── index.ts      # ModelsDev.get — fetches models.dev catalog (lazy helper inlined here)
    └── models-snapshot.json # Bundled trusted catalog snapshot — the weekly workflow regenerates THIS file (#471)
```

## KEY PATTERNS

- **Narrow root public API**: `src/index.ts` intentionally exports only `Auth`, `Provider`, `ModelsDev`, LLM error classes, `run`, and `RunInput`. Do not add session/protocol helpers, `ProviderTransform`, `fetchProxyModels`, `enrichWithCatalog`, `Processor`, `Retry`, `Message`, `Tool`, `toModelMessages`, or `TokenTracker` back to the root barrel (`TokenTracker`'s only consumers are llm-internal — `processor/stream-events.ts` deep-imports it). Use deep imports inside `packages/llm` tests/internal code when those helpers are needed.
- **`run()` entry point**: Takes `RunInput` (messages, tools, required model, required `trace` and `events`, optional auth, system, toolExecutor, toolChoice, maxSteps, providerOptions), drives a Processor loop, and returns `Run.Outcome` via the injected `Sink`. `RunInput.model` is required; do not reintroduce model-less/noop fallback behavior in `run()`.
- **Provider.Model**: Zod schema carrying only consumed catalog metadata — identity (`id`/`providerID`/`name`/`family`), SDK routing (`api.npm`/`api.url`/`api.id`), resolution keys (`status`/`release_date`), and `limit.context`. Built from `models.dev` data via `Provider.fromModelsDevModel()`; `Provider.listModels()` is the catalog lookup. Fields models.dev publishes but nothing here reads (capabilities, cost, options, headers, modalities) are deliberately absent — re-add one only together with its reader.
- **Auth.Info** (discriminated union): `{ type: "api", key }` | `{ type: "proxy", baseURL, apiKey? }`. Stored via `Auth.set(providerId, info)` and read by `getSDK()` before each call.
- **SDK wiring** (`provider/sdk.ts`): `getSDK(model, auth)` resolves to Anthropic / OpenAI. Custom OpenAI-compatible endpoints use `@ai-sdk/openai` with `baseURL` / `name`, keeping returned language models on the same AI SDK provider type version. SDK and `LanguageModel` instances are cached per `providerID:npm:modelID:auth` key. Provider-specific behavior belongs in `provider/`, `auth/`, or `transform/`, not in call sites.
- **Provider transforms** (`provider/transform.ts`): `normalizeMessages()` filters empty blocks and sanitizes tool-call IDs; `applyAnthropicCaching()` marks ONLY the latest user message (1h TTL) — the system and last-tool breakpoints are marked by `run.ts` via `anthropicCacheOptions` (#532 policy: three of the four allowed breakpoints at the stable→volatile seams). This is an internal/deep import surface, not a root export.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, trace, events, sink?, createStream, maxRetryAttempts? })`. `trace` and `events` are required: a record filed without a trace names nothing, and `events` is where every record goes. `process({ system })` resolves on stream completion and throws on abort/terminal error; `run()` maps that to `Run.Outcome` and publishes `LlmCall.Completed` on success or `LlmCall.Failed` (with `aborted`) otherwise — every `Started` gets a terminal event. Parts are published **copy-on-write**: a published part object is never mutated afterwards, so sink consumers may hold snapshots; text/reasoning content is folded into per-attempt state and emitted at part BOUNDARIES (#545 T2), not re-published per delta. Tool parts go `running` (with `time.start`) at `tool-call` and close with a real duration at `tool-result`. Processor owns `tool-call`/`tool-result` stream projection; tool *execution* happens only in `run()`'s AI SDK `execute` callback, which must not directly emit tool sink events. Status snapshots are `busy` → (`retry`…) → `idle`, exactly one `idle` per process() call.
- **Retry**: raw AI SDK errors (`AI_APICallError`) must pass through `coerceApiError` before classification — their retry fields live on the error object, not under `.data`, and never match `APIError.isInstance`. The one entry is `Retry.decide(attempt, error)` → a typed `Decision` (`retry` with reason + delay, or `stop`): classification sniffs payload (message, then responseBody), then statusCode (429 / ≥500), then the provider `isRetryable` flag; delays respect `retry-after` / `retry-after-ms` headers up to 60s — an explicit directive ABOVE the cap is a fail-fast decline, not a clamp (only an inferred ratelimit-reset demotes to backoff) — with headerless backoff capped at 30s. The pre-#544 `Retry.delay`/`Retry.isRetryable` members are GONE — their absence is pinned by `test/retry/retry.test.ts`. Processor retrying is finite by default; do not use unbounded retry loops or publish `Number.MAX_SAFE_INTEGER` as a retry cap.
- **TokenTracker**: Extracts token usage from AI SDK/provider responses. Runtime accounting stores token counts on the assistant message, keyed by that message's provider/model identity. The llm package does not calculate dollar cost.
- **ModelsDev**: Lazy-loads the catalog from `models.dev` into a local cache, falls back to a bundled snapshot. Respects `OPENOMNI_MODELS_URL`, `OPENOMNI_MODELS_PATH`, `OPENOMNI_DISABLE_MODELS_FETCH`. Remote/cache catalog data is untrusted: only providers backed by bundled AI SDK packages are exposed, provider `api` URLs are stripped, and model-level provider overrides are stripped before caching/returning.
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Custom OpenAI-compatible endpoints must come from explicit `Provider.Model` config, trusted bundled snapshot data, or proxy auth.

## ANTI-PATTERNS

- Do NOT import `Bus` here. `llm` reports through the `events` port it is handed; reaching for the process-wide bus re-couples the package to an implementation the composition root is supposed to choose (#606). `check-deps` carries a separate `srcAllowedDeps` for this package — `src/` may import `@openomni/protocol` and nothing else, even though the manifest lists `telemetry` for the tests.
- `packages/llm` sets `noEmit: true` in tsconfig — it does NOT produce a `dist/`. It is consumed as source by Bun.
- Do NOT raise `lib` in `tsconfig.json`. `main` points at `src/index.ts`, so `agent` and `server` pull this package's sources into their own programs under their own `lib: ["ES2020"]` — widening here would let an ES2022 builtin pass llm's gate and surface as an error attributed to a consumer. The test tree, which nothing imports, is checked separately by `tsconfig.test.json` at ES2022; `check-types` runs both.
- Do NOT add provider-specific logic to call sites. Keep SDK wiring in `provider/`, credential handling in `auth/`, and message/request shaping in `transform/`.
- Do NOT bypass `Auth.get()` for credentials (e.g. reading env vars inline). All credentials flow through the namespace.
- Do NOT hand-craft provider-specific request rewriting at call sites — keep it behind provider or transform modules so it stays in one place.
