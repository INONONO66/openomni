# Issue #1049 work report

- Created isolated worktree from origin/main.

- Dependencies installed and initial build passed (6 tasks).

- Read issue and native wrapper/workflow; original step died after 146 seconds and even always() artifact upload was skipped. Campaign stdout is captured by nativeJson.

- Traced campaign: snapshot + execution hash, all TS programs/enumeration/Python, diagnostics, baseline full selection, sequential mutants. execute kills detached child groups with SIGKILL, not SIGTERM; native wrapper buffers both streams.

- Added first diagnostic increment: streamed stderr with retained receipts, phase/mutant progress, explicit pilot-only wrapper path, workflow pilot_limit + Linux memory/disk/time sampler. No baseline or mutant selection changes in full mode.

- Diagnostic increment: LSP has no errors/warnings, script TypeScript gate passed, 79 related/CI tests passed including an event-driven stderr-before-exit integration test.

- Diagnostic increment gates passed: ultracite, lint, and build. Committing and dispatching five-candidate hosted pilot to locate the SIGTERM.

- Mutation integration test command completed with exit 1 (log /tmp/g11-mutation-tests2.log). Prior run was interrupted by the tool timeout, not a test verdict.

- Hosted diagnostic pilot 34674012661: 16 GiB runner, peak RSS 14,835,820 KiB; memory pressure starts in compiler enumeration before baseline. Disk remains 82 GiB free. Baseline then hits hardcoded 15-second whole-suite watchdog (SIGKILL), yielding no mutants. Original SIGTERM was not reproduced; resource pressure and independently broken baseline deadline are observed.
- Broader tests: 65 pass/26 fail, Python cases; investigating pinned Python environment before rerun.

- Failure mechanism: 29 simultaneously retained compiler programs/checkers reach 12.9 GiB RSS, still retained while spawning baseline children. Baseline uses the per-test 15s setting as the whole-process deadline. Fix preserves the per-test bound and inventory, but processes compiler projects sequentially and releases them before tests.

- Implemented sequential first-owner compiler analysis with unchanged fallback membership, explicit low-memory Bun children, and per-file/project aggregate process deadlines while retaining 15000ms per-test timeout. Added eager-versus-sequential candidate/census equality regression. Python test failures were under local 3.13.15, not the required 3.12.12; pinned interpreter is installed.

- Pinned Python 3.12.12 related test run exit: 0 (log /tmp/g11-tests3.log).

- Root-fix gates passed: 171 tests (single complete pinned-runtime run), TypeScript, ultracite, lint, build. Committing second increment and dispatching hosted pilot.
