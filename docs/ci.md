# CI verification

## Selection and merge results

PR verification uses the PR merge result, not only its branch tip. The planner
compares the PR base with that tested commit using NUL-delimited Git paths,
including both endpoints of renames. A Git or topology error fails planning.

`script/topology.ts` owns workspace identities and permitted dependencies.
`script/ci-plan.ts` selects changed workspaces and their transitive consumers.
It uses the broader dependency band, including test dependencies. Every code
change also selects script tests, which consume repository contracts.

Examples:

- `packages/ui/**`: UI, desktop, and script tests.
- `packages/ledger/**`: ledger and its transitive consumers, plus scripts.
- Protocol, workspace manifests, lockfiles, scripts, CI configuration, root
  configuration, and unknown paths: full verification.
- Root README, CONTRIBUTING, or a top-level `docs/*.md` change alone: no
  executable jobs. Package-local documentation still selects that package.

Main pushes, daily scheduled runs, and manual CI dispatch always select all
lanes. Selection narrows workspace tests and typechecking; global architecture,
lint, and quality gates still run for executable changes.

## Execution

The shared setup action installs Bun 1.4.1, pinned in `package.json`,
and uses `bun install --frozen-lockfile`. Only the package download cache is
reused. Test results are not cached. Alarm monitoring requires Bun >=1.4.0
for its built-in PTY support; unsupported runtimes refuse app construction.

The Build job creates workspace `dist` artifacts once per run. Typechecking,
quality checks, and test lanes restore the same archive and reject missing
outputs. Workspace tests run in separate jobs with their own files, ports, and
process environments. Tests do not wait for unrelated lint or typecheck jobs.
Machine integration uses Python 3.12.

Every coverage lane produces fresh LCOV and runs the ratchet for that lane.
Missing executable source records, malformed counts, empty instrumentation,
and an unknown lane fail. A selected PR does not borrow old reports from
unselected workspaces. Full runs select every lane. Noncoverage lanes remain
explicit in topology; they are tested without inventing a coverage baseline.

The recursive script lane runs conformance and tool tests once. There are no
extra duplicate conformance/topology/tsconfig test steps.

`Test` and `CI` are stable completion checks. They run even after upstream
failure and reject failed, cancelled, missing, or unexpectedly skipped jobs.
Only skips justified by a valid docs-only/empty plan are accepted. Configure
the repository ruleset to require `CI`; adding the workflow does not itself
change GitHub branch protection. Benchmark checks are post-merge checks and
must not be required for PR admission.

## Local reproduction

Use the pinned Bun version, a clean build, and the same commands as CI:

```bash
bun install --frozen-lockfile
bun run ci build
bun run script/ci-plan.ts --full
bun run ci test --lane agent
bun run ci test --lane scripts
bun run lint
bun run script/check-topology.ts
bun run script/check-deps.ts
bun run script/check-import-cycles.ts
bun run script/check-dead-exports.ts
bun run script/verify-tsconfig-inheritance.ts
bun run script/verify-ledger-rename.ts
bun run script/check-ledger-schema-drift.ts
```

The planner accepts `--base <full-SHA> --head <full-SHA>` for a local change
comparison. Save its JSON output and pass the path to
`bun run ci check-types --plan <file>`. On GitHub non-PR events the planner
intentionally selects everything.

`bun test --timeout 15000` remains a useful local test command, but is not
equivalent to all CI gates. `bun run ci test --lane <key>` matches a CI lane,
including its coverage check. Do not use a cached Turbo test result as evidence
that a fresh coverage report was produced.

Coverage baseline updates require all valid lane reports and cannot combine
`--update` with a selected lane. Baseline policy changes remain reviewable
changes; invalid instrumentation is never a reason to lower a floor.

## Benchmark references and diagnostics

Benchmark collection validates its repeat-count input before running samples.
Its p50 and p95 describe the distribution of per-run means, not operation-level
tail latency. When a workload changes meaning, review its metric identity and
comparison reference rather than silently accepting a different measurement.

The publisher compares the new result before pushing a reference update.
A failed alert cannot advance the remote reference for the next run. Successful
comparisons advance it; this is not a fixed long-term absolute performance
budget. Failed observations remain available in run artifacts.

Memory regression guards run independently, so their failure does not discard
completed benchmark samples or skip the comparison. Coverage, selection, and
benchmark artifacts are retained for 14 days, including available partial
results on failure. Local model/cache/auth and packaging tests must use
test-owned paths, not operator configuration or shared release staging.
