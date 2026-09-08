# Census callback hotfix

- Added scheduled DOM callback contracts for `requestAnimationFrame`, `cancelAnimationFrame`, and `requestIdleCallback`.
- Added generic declaration-only external registration handling for `subscribe`/`onXxx`, plus structural `Window.desktop` contextBridge callback handling.
- Native process failures now report compact parsed census errors (bounded to 20 rows/400 chars and 4 KiB total fallback), while receipts retain full output.
- Added focused RED-first regression coverage for scheduled, external declaration-only, bridge callbacks, and compact native errors.

## Verification

- Focused tests: green (2 focused tests; the native process suite also passed independently with 3 tests).
- Build: green.
- check-types, ultracite, dead exports: green.
- Full census export receipt: complete=true, 900.16s wall time; quality-measure remained nonzero due 320 existing findings and did not finish cleanly within the run window.
- Store/publisher repros were blocked by the repository's Python 3.12.12 tool-version requirement / run timeout.

PR and merge status will be recorded here after publication.
