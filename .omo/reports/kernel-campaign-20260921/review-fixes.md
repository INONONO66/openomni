# Effect foundation review fixes

Resumed against fb75a430 (benchmark agent commit); shared coverage edits remain untouched.

## A. Dynamic-import runner provenance
Awaited imports, aliases, direct destructuring and computed members are implemented. Seven positive production fixtures and one excluded-protocol negative fixture pass (59 combined checker/service tests). All checker callback parameters are now annotated; final gates pending.

## B. Typed Effect failures
Completed semantic replacements: both prepareMessage refusals use channels' SendAdmissionConflict (new barrel export only), duplicate alarm start uses existing AppLifecycleFailure, missing ingress receipt uses ledger CorruptRecord (surfaced as CommitFailed), and model context overflow uses new ContextAdmissionError in the agent union/barrel/exhaustive evidence and contract fixtures. Reusing generic ForeignFailure was considered but rejected where existing semantic tags fit. Added five app branch/boot integration tests and strengthened existing context admission test with Effect.flip. Focused run: 6 pass, 0 fail, 14 assertions. Alarm duplicate start is reported, rethrown and disposes its real app scope. Changed-file lint passed. App type check currently blocked by concurrent edits to effect-runtime.test.ts (not our file); no edits made to that agent's work.

## C. Service contracts
Count/type/uniqueness assertions at the review sites removed; compile-time fixtures retained. Removed the remaining runtime typeof/uniqueness tautologies too; Context behavior and compile-time pins remain. Changed-file lint passed.

## D. EOF
Extra EOF blank line removed from captured-catalog.test.ts; working-tree diff whitespace check passed.

## Gate evidence (shared-tree snapshot)

Focused typed tests pass: 6 pass, 0 fail. `script/check-dead-exports.ts` passes. Changed-file ultracite passes. Full tests currently report 2 failures in concurrent work (`apps/openomni/test/effect-runtime.test.ts` has an undefined `runtime`, plus a 5-second process-loss timeout); full lint/ultracite report concurrent machines test edits and full check-types reports concurrent malformed `packages/llm/test/processor/failures.test.ts`. Boundary checker is blocked by concurrent malformed llm test syntax and stale ratchet rows from concurrent test edits. These are not caused by the files above.

No commit or push of these fixes yet. No final gates claimed.
