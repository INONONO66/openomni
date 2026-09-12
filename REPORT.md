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

- Created PR for the two tested increments; post-fix pilot 34674877134 running.

- Post-fix pilot 34674877134 survived 20m45s without a signal. Peak RSS fell to 6,286,128 KiB; test-time total used memory generally 2-3 GiB. Baseline now finishes: 4400 tests, 173 failures, exit 1, no timeout/signal. Mutants correctly remain blocked by red baseline. PR checks complete; inspecting baseline execution-context failures before deciding next increment.

- Pilot blockers now proven: missing .git in existing snapshot causes source_revision_unavailable / git repository failures; monolithic suite also has cross-suite/environment failures. These predate this fix and are not suppressed. Full branch dispatch started as requested; PR Quality diagnostics being checked.

- Added real in-process campaign/receipt comparison and native pilot-wrapper integration coverage; explicit generator return/next types remove quality-census implicit any at yield sites. No test-body wording assertions or bypasses.

- In-process integration gate test exit: 0 (log /tmp/g11-tests4.log).

- Third increment gates passed: 173 tests together, TypeScript, ultracite, lint, build. Real campaign is now 91.55% line-covered in process; native wrapper 87.86%. Full branch run 34675894684 remains under background gh run watch.

- Full branch run 34675894684 completed; bounded phase/resource evidence saved /tmp/g11-branch-full.log.

- Commented issue #1049 with memory, signal, disk, baseline, and branch-run evidence. PR #1051 remains intentionally unmerged because Quality/CI checks fail; no auto-merge invoked.

- Resumed #1051: restoring execution-copy Git metadata and resolving changed-line Quality findings before pilot/merge.

- Git needs confirmed: HEAD/tree revision, log/objects for local fetch, index for git grep/ls-files, and refs for CI planning. Detached worktrees now preserve these; overlay includes current dirty/untracked inputs and physical dependencies, no external node_modules symlink exception. Cleanup checks Git registration removal.

- Split baseline/probe/mutated test execution by nearest package manifest without excluding inventory tests; this restores package cwd/config and isolates desktop/UI runtime globals. Every batch process/JUnit is retained and a failed batch still blocks scoring.

- Worktree/package-batch integration test gate exited 1; log /tmp/g11-tests5.log.

- Gates tsc/ultracite/lint/build passed. New full-wrapper test reached normalization but failed; reading exact assertion before fixing it. Worktree isolation and in-process two-package campaign tests passed.

- Full-wrapper regression corrected to use a quality-owned packages/... source (the first fixture had no quality-owned inventory). Native wrapper now passes 4 tests and reaches full normalization + fail-closed missing-baseline ratchet; prior complete run had 174/175 with only that fixture failure. Other local gates passed.

- Full related test command after fixture correction exited 0 (log /tmp/g11-tests6.log).

- Hosted pilot 34677629184: Git/package fix removed all observed assertion failures (3684 tests, 0 failures), but a batch process still failed; inspecting its retained receipt. Local full related run: 175 pass/0 fail.

- Pilot third run has 12 green package batches (3684 tests, zero failures); tooling batch was killed by derived 13-minute watchdog, not OOM. Keeping 15s per-test bound, separating suite deadline. Desktop smoke had Electron startupData null; used the single authorized rerun. Quality changed-line rows plus unrelated census CRAP growth remain under investigation.

- Synchronized origin/main #1052 census performance fix (ordered-removal/scope cache), which landed during this task. Desktop smoke authorized rerun passed. Main comparison drift explained unrelated census rows; no unrelated source edits made.

- Separating the test-process budget from per-test deadlines: per-test limit remains 15000ms; long tooling suites get an explicit bounded suite budget instead of a deadline inferred from file count.

- Explicit suite deadline/refactored assertion parsing test gate: exit 0, /tmp/g11-tests7.log.

- All local gates passed after explicit one-hour per-package suite deadline (15s per-test retained): 175 tests, tsc, ultracite, lint, build. Extracted assertion parsing to reduce runTestBatch complexity; native fixture setup deduplicated.
