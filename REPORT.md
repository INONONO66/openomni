# Issue #1049 work report

- Created isolated worktree from origin/main.

- Dependencies installed and initial build passed (6 tasks).

- Read issue and native wrapper/workflow; original step died after 146 seconds and even always() artifact upload was skipped. Campaign stdout is captured by nativeJson.

- Traced campaign: snapshot + execution hash, all TS programs/enumeration/Python, diagnostics, baseline full selection, sequential mutants. execute kills detached child groups with SIGKILL, not SIGTERM; native wrapper buffers both streams.

- Added first diagnostic increment: streamed stderr with retained receipts, phase/mutant progress, explicit pilot-only wrapper path, workflow pilot_limit + Linux memory/disk/time sampler. No baseline or mutant selection changes in full mode.

- Diagnostic increment: LSP has no errors/warnings, script TypeScript gate passed, 79 related/CI tests passed including an event-driven stderr-before-exit integration test.

- Diagnostic increment gates passed: ultracite, lint, and build. Committing and dispatching five-candidate hosted pilot to locate the SIGTERM.
