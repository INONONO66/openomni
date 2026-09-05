# Coverage restoration for #936

## Final measured package coverage

The last clean package measurements before the concurrent executor/session source refactor were:

- `packages/agent`: **97.85%** (4646/4748 lines), which is within the ratchet's 0.5pp tolerance of the 98.2% baseline and produced no agent violation.
- `packages/policy`: **97.98%** (2082/2125 lines), above the 96.85% baseline by 1.13pp.

Final policy ratchet output:

```text
IMPROVED: packages/policy: line coverage improved 1.13pp over baseline (96.85% → 97.98%) — shrink the baseline via --update
```

No baseline or tolerance was changed and `--update` was never used.

After that measurement, concurrent production work changed `packages/agent/src/tool-dispatcher.ts` and `packages/agent/src/session-handle.ts`. The final attempted agent run reported 21 existing-test failures and one error, so its partial 93.72% report is not a valid completed-suite measurement. The concrete blockers were:

- `session-handle.ts:727`: `CommitResult` is not narrowed before reading `receipts`; the session suite then times out/fails while policy rows are concurrently wired.
- `tool-dispatcher.ts`: executor result typing currently fails `check-types`; existing dispatcher tests still call the replaced optional-hook API.

Per coordination instructions, these in-flight production changes were not edited or reverted here.

## Behaviours covered

### Agent observation bus and sinks

- asynchronous publish and FIFO subscriber order
- subscriber error isolation and publish-time subscription snapshots
- all-fields match filtering
- wildcard observers receiving descriptors, schema parsing, and every primitive payload
- async-local isolated subscriptions remaining separate from root state
- authoritative scoped identity/time/event IDs and child identity merging
- invalid payload and sink/reporter failure containment
- subscription forwarding, collector grouping/reset, noop sink behavior, and compact trace IDs

### Agent dispatcher and session runner

- tool metadata and object-root schema validation
- model/session spec projection and query replay-safety classification
- unregistered tool and invalid-input classification without execution
- explicit refusal versus execution failure classification
- typed cell output versus bounded/truncated model output
- interruption at each session boundary
- pre-LLM message injection, post-LLM continuation, and model-turn ordering
- reported failures becoming typed session errors while unreported failures rethrow

### Policy compiled rows and registration

- generation mismatch, invalid match, and invalid verdict typed failures
- require-approval short-circuiting lower-priority rules
- redaction traversal over non-object paths
- append load and append storage failures
- caller-owned verdict top-level and nested data cannot mutate a compiled snapshot
- per-engine factory state isolation
- invalid/nested factory rejection and asynchronous direct callback rejection
- middleware failure audit correlation using the dispatch trace

## Mutation proof

Applied mutation:

```text
verdict: Object.freeze(verdict.data)
-> verdict: Object.freeze(row.verdict.value as RowVerdict)
```

Result with mutation: **FAIL**, 4 pass / 1 fail. The new verdict-isolation test failed at caller mutation with `TypeError: Attempted to assign to readonly property`, proving the compiled snapshot had aliased and frozen caller-owned verdict data.

After restoring `packages/policy/src/row-compiler.ts`: **PASS**, 5 pass / 0 fail, 14 assertions.

## Deleted branches

None. Every targeted branch covered here was reachable through a public package surface.

## Verification

Passed:

- policy coverage: 170 pass / 0 fail
- policy `check-types`
- focused agent tests added here: 23 pass / 0 fail
- `bunx ultracite check --formatter-enabled=false .`: 768 files checked, no errors
- mutation fail/pass proof above

Blocked by concurrent production source changes (not caused or repaired by this test-only work):

- agent `check-types`
- completed agent coverage run
- whole-repository test run
- dead-export check (new concurrent exports `createToolExecutionObservationOwner`, `DispatcherOptions`, `Executor`, and `SessionActionCommitPort`)
- full ratchet also reports missing reports for packages whose coverage commands were not run in this worktree
