# W4 #1112 — duplicate retry/abort owner audit

Date: 2026-09-29  
Lane: A6  
Base: `8390912c`

## Measured owner census

| Concern | Command | Before | After | Decision |
| --- | --- | ---: | ---: | --- |
| Provider step cap | `grep -RIn 'maxSteps' packages/llm/src packages/agent/src apps/openomni/src` | 2 | 0 | Delete. `RunInput.maxSteps` was never read; `provider/stream.ts` owns the invariant with `stepCountIs(1)`. |
| LLM retry delay owner | `grep -RInE 'Retry\.sleep\|waitForRetry' packages/llm/src/retry` | 1 | 0 | Delete. `Retry.sleep` had no production caller; logical retry scheduling remains in the agent attempt driver. Pure classification, Retry-After parsing, provider floor, usage/model/auth resolution remain. |
| Executor manual cancellation | `grep -nE 'AbortController|addEventListener\(.*abort|Promise\.race|runWaveBodies|waveBodyScope|ambientSignal|settledExecution' packages/agent/src/{executor-attempts,executor-recovery,session-controller}.ts packages/agent/src/core/execution/{run,tool-wave}.ts` | 0 | 0 | No residue. |
| Tool invocation cancellation | same expression over `packages/agent/src/tool-body.ts` | 2 | 2 | Keep. The controller and listener scope one raw tool invocation and bridge its executor context; they do not schedule or repeat model attempts. |
| Channel retry/backoff | `grep -RInE 'backoffDelayMs|calculateBackoff|setTimeout|Schedule' packages/channels/src/support` | 5 | 5 | Keep. `fetch-retry.ts` retries one perimeter HTTP request after a platform 429; `reconnect-backoff.ts` and `socket-shell.ts` reconnect transports. Neither is a model-attempt loop. |
| Composer lifecycle | `grep -RInE 'mount|dispose|ManagedRuntime|Effect\.run' apps/openomni/src/composition` | 0 | 0 | No residue. `composition/composer.ts` is absent; no unreachable mount/dispose entry point moved elsewhere in composition. |

## Deletions

- Removed inert `RunInput.maxSteps`, its sole agent writer, and stale forwarding tests.
- Removed orphaned `Retry.sleep` and its implementation-only tests.
- Preserved retry classification and delay calculation in `packages/llm/src/retry/`.
- Preserved the agent logical-attempt driver and its cancellation/resource ownership.
- Preserved channel HTTP retry and socket/poller reconnect behavior.

## H10 disposition

**H10 disposition for #1112:** closed — `maxSteps` is grep-zero in
`packages/llm/src`; orphaned `Retry.sleep` is grep-zero in
`packages/llm/src/retry`; the named executor files have zero duplicate
abort/race owners; the two `tool-body.ts` hits are one invocation-scoped
cancellation bridge; the five channel-support hits are perimeter HTTP
retry/transport reconnection and survive by contract; composition has zero
mount/dispose residue.
