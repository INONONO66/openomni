# packages/llm

LLM provider abstraction. Owns Owner credential loading/materialization, provider SDK wiring, validated model catalogs, boundary sanitization, streaming, retry, message conversion, token accounting, and the `run()` entry point. Depends on `@openomni/protocol` and `@openomni/session` for observation only.

## STRUCTURE

```
src/
├── index.ts          # Narrow public API: OwnerCredentialSource, Provider, ModelsDev, errors, run, RunInput, TokenTracker
├── run.ts            # run() — model-required top-level entry: messages+tools → Run.Outcome via Sink
├── error.ts          # ProviderError (NamedError.create) + NamedError/APIError re-exports
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
│   ├── credential-source.ts # Strict parser for Owner-controlled credential facts
│   ├── owner-source.ts # Production Owner credential-file loader into opaque handles
│   ├── secret-registry.ts   # Production opaque SecretRegistry/materialization boundary
│   └── boundary-sanitizer.ts # Production exact-secret boundary redaction
├── provider/
│   ├── index.ts      # Provider + ModelsDev public namespaces; internal provider helpers stay deep
│   ├── sdk.ts        # getSDK() + getLanguage() — maps Provider.Model to @ai-sdk/* instance
│   ├── transform.ts  # ProviderTransform — message normalization, caching, per-provider variants
│   └── proxy-models.ts # Proxy model catalog fetch/enrichment
├── token/
│   └── index.ts      # TokenTracker.extractUsage
└── model/
    ├── index.ts      # ModelsDev.createService — sole validated catalog TTL owner
    ├── models-snapshot.json # Bundled trusted catalog snapshot — the weekly workflow regenerates THIS file (#471)
    └── catalog-cache.ts # Production validated cache/remote/bundled catalog loader with typed diagnostics
```
## P2-04 PRODUCTION CONTRACT

- `OwnerCredentialSource.load()` is the only production credential loader. It parses the Owner-controlled source into a paired `SecretRegistry`/`BoundarySanitizer`; consumers retain opaque handles and redacted `Execution.CredentialSourceRefV1` values only.
- `ModelsDev.createService()` is the sole mutable catalog TTL owner. It validates cached, remote, and bundled artifacts, emits sanitized fallback diagnostics, and permits only the validated bundled catalog as an availability fallback. It never chooses a runtime model.
- `run()` requires an explicit `Provider.Model` plus an authenticated `LLMEnvironment`. The environment reference, credential handle, model digest, SDK package, and registry/sanitizer pairing are validated before materialization; missing or mismatched facts fail closed.
- Provider SDKs and language models exist only inside one `SecretRegistry.withMaterialized()` callback. They must not be cached or retained. The removed mutable `Auth` namespace and implicit model/credential fallback are not compatibility surfaces.

## KEY PATTERNS

- **Narrow root public API**: `src/index.ts` intentionally exports only `OwnerCredentialSource`, `Provider`, `ModelsDev`, LLM error classes, `run`, `RunInput`, and `TokenTracker`. Credential parsing, handles, and sanitization are exported only from `@openomni/llm/credential-runtime`. Do not add internal Processor/Retry/transform helpers or raw secret types to the root barrel.
- **`run()` entry point**: Takes `RunInput` with required messages, tools, `Provider.Model`, and authenticated `LLMEnvironment`; drives a Processor loop and returns `Run.Outcome` via the injected `Sink`. Do not reintroduce model-less, credential-less, noop, or implicit-provider fallback behavior.
- **Provider.Model**: Zod schema with capabilities, cost, limits, status. Runtime models come from an injected `ModelCatalogService`; `Provider.listModels()` / `listProviders()` / `getProviderInfo()` require that service explicitly.
- **Credential boundary**: `OwnerCredentialSource` loads Owner facts, `SecretRegistry` retains opaque handles, and `BoundarySanitizer` redacts exact secret forms at external boundaries. Raw material exists only during a provider-scoped callback and is never serializable.
- **SDK wiring** (`provider/sdk.ts`): `getSDK(model, credential)` and `getLanguage(model, credential)` require a materialized provider-matched credential. Custom OpenAI-compatible endpoints use `@ai-sdk/openai`; OpenAI proxy credentials select Chat Completions explicitly. SDK and `LanguageModel` instances must not escape the callback or be cached.
- **Provider transforms** (`provider/transform.ts`): `normalizeMessages()` filters empty blocks, sanitizes tool-call IDs, applies Anthropic ephemeral caching to the last two user/assistant messages. `variants(model)` exposes per-provider thinking / reasoning presets; `resolveVariant(model, variant?)` picks one. This is an internal/deep import surface, not a root export.
- **Processor**: Created via `Processor.create({ assistantMessage, sessionID, model, abort, sink, onToolCall, createStream, maxRetryAttempts? })`. `process()` returns `"stop" | "continue" | "compact"`. Accumulates `TextPart` / `ReasoningPart` / `ToolPart` and publishes through `Sink`. Processor owns `tool-call` and `tool-result` stream projection; `run()`'s AI SDK `execute` callback must not directly emit tool sink events.
- **Retry**: `Retry.delay(attempt, error?)` computes backoff respecting `retry-after` / `retry-after-ms` headers. `Retry.isRetryable(error)` checks `APIError.isRetryable`. Processor retrying is finite by default; do not use unbounded retry loops or publish `Number.MAX_SAFE_INTEGER` as a retry cap.
- **TokenTracker**: Extracts token usage from AI SDK/provider responses. Runtime accounting stores token counts on the assistant message, keyed by that message's provider/model identity. The llm package does not calculate dollar cost.
- **ModelsDev**: `createService()` owns validated catalog loading and its TTL/in-flight cache. Cache and remote data are untrusted, bundled-provider allowlists are enforced, and the validated bundled snapshot is the sole availability fallback. Returned fallback/cache diagnostics must reach the injected sanitized incident sink; catalog fallback never chooses a model or becomes durable authority.
- **Two bundled providers**: `@ai-sdk/anthropic`, `@ai-sdk/openai`. Custom OpenAI-compatible endpoints must come from explicit `Provider.Model` config, trusted bundled snapshot data, or proxy auth.
- **P2 ownership:** LLM alone owns credential loading/materialization, provider choice, catalog validation/cache, and secret-boundary sanitization. Kernel/session/server may carry redacted references or injected ports, but must not read raw credentials, choose providers, or implement another cache.

## ANTI-PATTERNS

- `packages/llm` sets `noEmit: true` in tsconfig — it does NOT produce a `dist/`. It is consumed as source by Bun.
- Do NOT add provider-specific logic to call sites. Keep SDK wiring in `provider/`, credential handling in `auth/`, and message/request shaping in `transform/`.
- Do NOT read credentials directly at provider callsites or recreate mutable Auth storage. Production loading flows through `OwnerCredentialSource`; execution receives only a `SecretHandle` and materializes it through the paired registry for one callback.
- Do NOT hand-craft provider-specific request rewriting at call sites — keep it behind provider or transform modules so it stays in one place.
