# packages/llm

Refreshed 2026-09-29 (W5.3 #1113, branch `kernel/1113-w5-closure-20260929`). Single-attempt ownership matches #937; W4 #1112 deleted the inert `RunInput.maxSteps` and orphaned `Retry.sleep`; A4 added usage provenance.

LLM provider abstraction on Effect `4.0.0-rc.118`: auth (API key + proxy), provider SDK wiring, streaming, retry classification, message conversion, token usage accounting, and the `run()` entry point. `src/` may import `@openomni/protocol` and nothing else in the workspace (`check-deps` `srcAllowedDeps`); it reports through an injected `BusEvent.Sink` and imports nothing durable (#606). Tests run Effects only through the package's single runner owner, `test/helpers/native.ts`.

## STRUCTURE

```
src/
├── index.ts          # Public API: errors, Llm, LlmLive, Auth, Provider, ModelsDev, Retry, selectModel, accumulateUsage, observeRetry, run/Run/RunInput, Sink
├── run.ts            # run() + package-owned Run.Outcome; model/trace/events required; one Processor attempt
├── services.ts       # Llm Context.Service tag ("@openomni/llm/Llm": run + resolveModel)
├── layers.ts         # LlmLive = Layer.succeed(Llm, { run, resolveModel })
├── sink.ts           # Streaming callbacks: message snapshots and paired tool projections
├── errors.ts         # Data.TaggedError classes (APIError, LlmRunFailure, LlmFailure, ...) — the LlmError union
├── error.ts          # coerceApiError + error-fact extraction over the errors.ts classes
├── message/index.ts  # toModelMessages() — Message.WithParts[] → AI SDK messages
├── processor/        # index.ts (one attempt, transcript fold), stream-events.ts (part projection + usageProvenance fork), tool-events.ts, event-schema.ts, normalize.ts
├── retry/            # index.ts (Retry.decide/classifyFailure, budgets), delay.ts (retry-after headers), telemetry.ts (observeRetry)
├── auth/             # index.ts + storage.ts — atomic mode-0600 credential writes
├── provider/         # index.ts (resolveModel), identity.ts (single user-agent owner), sdk.ts, stream.ts (stepCountIs(1), maxRetries: 0), transform.ts, proxy-models.ts
├── token/            # index.ts (extractUsage/estimateUsage/accumulateUsage) + schema.ts
└── model/            # index.ts (ModelsDev.get), loader.ts, schema.ts, select.ts (selectModel fallback walk), models-snapshot.json
```

## KEY PATTERNS

- **One attempt per invocation**: `run()` performs exactly one Processor attempt with AI SDK retries disabled (`maxRetries: 0`, `stepCountIs(1)` in `provider/stream.ts`). The receiving session executor owns attempt scheduling, re-admission, and durable failed-usage records. `RunInput.model` is required; there is no `maxSteps` option.
- **Effect service**: `Llm` (`services.ts`) exposes `{ run, resolveModel }`; `LlmLive` is the app-composed Layer. Consumers resolve the Tag; they do not import `run` deep paths.
- **Retry is classification, not scheduling**: `Retry.decide(attempt, error)` → typed `Decision` (retry reason + delay, or stop); `Retry.classifyFailure` is the outside-the-loop entry for hosts. Raw AI SDK errors must pass `coerceApiError` first. `retry-after`/`retry-after-ms` directives cap at 60s (an explicit directive above the cap declines rather than clamps), headerless backoff caps at 30s with jitter, quota/billing prose is the terminal `billing` reason, 4xx moderation verdicts are terminal `content_policy`. `Retry.sleep` and the pre-#544 `delay`/`isRetryable` members do not exist; no delay owner lives here.
- **Usage provenance (W5.3 A4)**: the accounting fork in `processor/stream-events.ts` marks each attempt `reported | estimated | unknown` — usable provider counts (including reported zero) stay `reported`; local-estimator substitution marks `estimated` and is sticky across steps; an unaccounted attempt stays `unknown`. `run.ts` carries `usageProvenance` on both successful evidence and `LlmRunFailure`; the agent's durable attempt-result writer persists it.
- **Usage accounting is provider-plus-local** (kernel §5.3): `extractUsage` returns `inputTokens`/`outputTokens` as `number | undefined` where `undefined` means unusable (absent, non-numeric, out of count domain); a reported numeric `0` is authoritative. Unusable fields substitute the injected `estimateUsage` port (default `ceil(chars / 4)`), field-wise, never throwing.
- **SDK wiring** (`provider/sdk.ts`): bundled `@ai-sdk/anthropic` / `@ai-sdk/openai` or an explicit OpenAI-compatible endpoint. Bounded LRU caches keyed by provider/package/URL, SHA-256 auth fingerprint, and transport fingerprint; raw credentials never appear in keys. Every instantiation defaults `headers["user-agent"]` to `clientIdentity()` (`provider/identity.ts`) — one owner, overridable by name.
- **Auth.Info**: `{ type: "api", key }` | `{ type: "proxy", baseURL, apiKey? }`. `Auth.set()` writes atomically at mode 0600; malformed JSON fails loudly. `run()` uses explicit auth first, then `Auth.get()` unless `allowAuthFallback` is false. Operator transport (`RunInput.transport`) is host-resolved; `baseUrl` outranks the catalog URL, proxy auth outranks both.
- **Processor**: `Processor.create({...})` folds one immutable transcript per attempt; snapshots emit at part boundaries. Tool names are provider-safe on the wire and mapped back in transcript facts; the Agent owns tool execution and authorization. Exactly one `idle` operational event per process call.
- **ModelsDev**: sanitized on-disk catalog → `models.dev` fetch → bundled snapshot fallback; respects `OPENOMNI_MODELS_URL` / `OPENOMNI_MODELS_PATH` / `OPENOMNI_DISABLE_MODELS_FETCH`; remote data is untrusted (bundled providers only, URLs stripped, prototype keys refused). `selectModel` (`model/select.ts`) walks a fallback chain on advancing failure reasons; retry owns termination.

## ANTI-PATTERNS

- Do NOT import `Bus` — report through the injected `events` port (#606).
- No `dist/`: `tsconfig` sets `noEmit: true`; consumers pull sources. Do NOT raise `lib` in `tsconfig.json` (consumers check this package under their own `lib: ["ES2020"]`; the test tree runs separately at ES2022 via `tsconfig.test.json`).
- Do NOT add provider-specific logic at call sites — SDK wiring in `provider/`, credentials in `auth/` (never inline env reads), message shaping in `transform.ts`.
- Do NOT reintroduce a zero default for the required usage counts, a typed usage error, `Retry.sleep`, or `maxSteps`.
- Do NOT call `Effect.run*` in tests outside `test/helpers/native.ts` — `check-effect-boundaries` enforces the single runner owner.
