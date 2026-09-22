# Effect foundation review fixes

Resumed against fb75a430 (benchmark agent commit); shared coverage edits remain untouched.

## A. Dynamic-import runner provenance
Implemented awaited imports, aliases, direct destructuring, Effect subpaths, and computed members in `script/check-effect-boundaries.ts`. Seven positive production fixtures and one excluded-protocol negative fixture pass. Checker callback parameters are explicitly typed.

## B. Typed Effect failures
Reused semantic typed errors: both `prepareMessage` refusals use channels' `SendAdmissionConflict`, duplicate alarm start uses existing `AppLifecycleFailure`, missing ingress receipt uses ledger `CorruptRecord` surfaced as `CommitFailed`, and model context overflow uses new `ContextAdmissionError` in the agent error barrel/union. Added exhaustive evidence and contract coverage plus five app branch/boot tests; alarm duplicate start is reported, rethrown and disposes its app scope. Focused blocker tests: 73 pass, 0 fail, 452 assertions across five files.

## C. Service contracts
Removed all review-site runtime tautologies (constant counts, `typeof listen`, Set uniqueness, and tag-key uniqueness) while retaining Context behavior and compile-time pins.

## D. EOF
Removed the extra EOF blank line from `packages/agent/test/captured-catalog.test.ts`.

## Commit and gate evidence

Fix commit `fd93adb4` (`fix(effect): typed failures on Effect-native paths; detect dynamic-import runners`) was pushed to `origin/kernel/w0-effect-foundation` after a successful `git fetch origin && git merge --ff-only origin/kernel/w0-effect-foundation`.

Passing: focused blocker tests (73 pass, 0 fail); changed-file ultracite; `script/check-dead-exports.ts`; `git diff --check origin/main...HEAD`; focused TypeScript checks for script, agent and app source; focused diagnostics for changed production files; focused app typed-failure tests (6 pass, 0 fail).

Shared-tree gates not green: full tests had 2 failures in concurrent work (`effect-runtime.test.ts` undefined `runtime`, and process-loss timeout); `check-effect-boundaries` had stale ratchet rows and malformed concurrent `packages/llm/test/processor/failures.test.ts`; turbo check-types hit that malformed llm test plus concurrent machines/policy errors; full lint/ultracite reported concurrent machines test edits. `script/check-dead-exports.ts` passed. These failures were not caused by the scoped files and were not modified.
