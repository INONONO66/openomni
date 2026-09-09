# CI verification

## Selection and merge results

PR verification uses the PR merge result, not only its branch tip. The planner
compares the PR base with that tested commit using NUL-delimited Git paths,
including both endpoints of renames. A Git or topology error fails planning.

`script/topology.ts` owns workspace identities and permitted dependencies.
`script/ci-plan.ts` emits plan v2: `class`, logical `lanes`, `qualityScope`,
`projects`, `toolingTests`, and the executable test `matrix`. Impact follows the
broader permitted dependency band, including test dependencies and transitive
consumers. Mixed changes take the maximum class in the table; scopes are unions.

| Class (ascending) | Trigger | Workspace tests | Quality scope | Tooling tests |
| --- | --- | --- | --- | --- |
| `docs` | Root `*.md` or `docs/**` only | None | None | No |
| `desktop` | `apps/desktop/**`, `packages/ui/**` | Affected workspaces and consumers | Affected source inventory | No |
| `kernel` | Other packages or `apps/openomni/**` | Affected workspaces and consumers | Affected source inventory | No |
| `tooling` | `script/**` except conformance contracts | Changed workspace lanes, if present | Whole inventory | Three shards |
| `global` | Protocol, manifests/lockfile, conformance contracts, CI/root configuration, malformed or unowned paths | All | Whole inventory | Three shards |

Package-local documentation retains workspace impact. Main pushes, schedules,
manual dispatch, and the planner's `merge_group` event mode select `global`.
The workflow trigger for merge groups belongs to the subsequent two-tier change.
`projects` comes from TypeScript's parsed tsconfig root-file lists intersecting
the affected file closure; planning never constructs compiler programs.

Repository contracts run on **every PR**, including docs-only PRs. Consequently
Build also runs for documentation changes, but workspace tests, static/dependency
jobs, and quality remain omitted. Build/pack/restore deliberately remain global:
contracts and consumers require the complete validated dist archive. Scoping that
archive and its producer is a follow-up, not an unverified saving claimed here.
The plan travels as `ci-plan.json` in the `ci-plan` artifact; only small selection
fields and the matrix travel through job outputs, never `qualityScope`.

## CI tiers and merge queue

CI has two tiers with the same job names and required `CI` status. The scoped PR
 tier uses the change class and affected closure from `ci-plan.json`; quality
runs for executable plans against the PR base SHA, while docs-only executable
jobs are skipped. Tooling self-tests run only when `script/**` changes.

The full tier runs on `merge_group`, pushes to `main`, nightly schedules, and
manual dispatch. It uses the global plan, all workspace lanes, the whole quality
inventory, and all tooling self-tests. The merge queue trigger is required so
its unchanged job contexts report the required status.

| Class | Workspace tests | Quality scope | Tooling self-tests |
| --- | --- | --- | --- |
| docs | none | none | no |
| desktop | UI/desktop closure | affected inventory | no |
| kernel | affected closure | affected inventory | no |
| tooling | scripts | whole inventory | yes |
| global | all | whole inventory | yes |

Only pull-request runs are cancellable; queue entries and main pushes are never
cancelled. Dependency review remains pull-request-only. The lead applies the
reversible ruleset requirement for `CI` with `gh api` after merge; this workflow
does not apply the ruleset.


## Operations

Partial workflow reruns are unsupported by design. `gh run rerun --failed` cannot
reliably pass the Script Coverage merge because `QUALITY_RUN` embeds the attempt
number; partitions produced by an earlier attempt fail the fail-closed freshness
check with `InventoryError: stale coverage partition: scripts-contracts`. Use a
full `gh run rerun <id>` (or push) instead. The typical reason a full rerun is
needed is the artifact-service 403 flake class tracked by
actions/upload-artifact#560.

## Execution

The shared setup action installs Bun 1.4.1, pinned in `package.json`,
and uses `bun install --frozen-lockfile`. Package downloads and Knip's validated
`node_modules/.cache/knip` cache are reused. The Knip key includes the lockfile,
configuration, census implementation and change class; Knip revalidates source
content. Test results and native coverage are not cached. Alarm monitoring requires Bun >=1.4.0
for its built-in PTY support; unsupported runtimes refuse app construction.

The Build job creates workspace `dist` artifacts once per run. Typechecking,
quality checks, and test lanes restore the same archive and reject missing
outputs. Workspace tests run in separate jobs with their own files, ports, and
process environments. Tests do not wait for unrelated lint or typecheck jobs.
Machine integration uses Python 3.12.

Every selected workspace produces fresh LCOV and runs its ratchet. On tooling/full
plans, the script floor runs only after merging all four fresh script partitions. #945 adds the first measured floors for machines, UI, and desktop; it does not invent old coverage evidence for those lanes.
Missing executable source records, malformed counts, empty instrumentation,
and an unknown lane fail. A selected PR does not borrow old reports from
unselected workspaces. Full runs select every lane. Topology remains the owner
of workspace lane membership and test commands.

`script/scripts-lanes.ts` is the explicit recursive test manifest. Its contract
test rejects missing, duplicate and newly unassigned `script/**/*.test.ts` files.
`scripts-contracts` contains topology, CI planning/execution, tsconfig inheritance,
ledger contracts and repository-consumer tests; its command also runs dead-export,
dependency and import-cycle self-tests plus ledger rename/schema checks.
`scripts-tooling` contains census, mutation, metrics, coverage and quality engine
self-tests. It runs only when `toolingTests` is true, as three matrix shards using
`--shard=i/3 --timings=coverage/timings.json --update-timings`. Bun 1.4.1 requires
a filename for `--timings`. No tests, including the intentional 20-second hang,
are removed or skipped.

Each script partition has a separate run/runtime/inventory-bound receipt.
`quality-coverage-record.ts merge` requires contracts and shards 1, 2 and 3,
validates every receipt and native LCOV record, and unions line counters before
running the unchanged script coverage floor. A shard's percentage is never
averaged or treated as the whole lane. Non-tooling PRs owe no tooling coverage.

Quality Static runs five independent matrix legs (`types`, `publisher`, `export`,
`store`, and `metrics`) after Build, in parallel with tests. The metrics leg
collects static complexity, instrumentation maps, and clones without coverage.
Each leg uploads `quality-leg-<leg>` with its measurement, identity, and native
process JSON where applicable. Identity records bind the inventory and contract
hashes, the scoped plan hash where applicable, and duration. The Quality fan-in
writes a per-leg phase/seconds table to `$GITHUB_STEP_SUMMARY`. Phase timings appear on stderr as
`[quality-phase] name=<phase> ms=<duration>`.

Quality Gates also runs after Build without waiting for tests. It runs ratchet
self-tests, dead-export and import-cycle checks, tsconfig inheritance, ledger
rename and schema-drift checks, and uploads `source-metrics`. Schema drift uses
Bun's SQLite; this job does not install Python.

Each selected coverage test lane seals one immutable native receipt. Quality
waits for tests and all Quality Static legs, downloads their artifacts, checks
Python, and runs `quality-measure.ts finish`. Finish rejects missing or stale
leg identities, verifies native coverage, joins coverage-dependent metrics, and
runs the ratchet. Its `quality-measurements` artifact retains `quality-results/`,
`quality-legs/`, and `ci-plan.json`, including available results on failure.
Per-leg artifacts and measurements are retained for 14 days.

Quality Static legs and Quality finish have 20-minute timeouts. Quality Gates
and script contracts/tooling shards have 15 minutes; workspace tests have 30.
Script Coverage has five minutes.
The final CI gate requires Quality Static, Quality Gates, and Quality to succeed
for executable plans; only planned documentation skips are accepted.

`d945-lcov-crap-upper-bound@1` uses only uniquely mapped, wholly executed source
lines; ambiguous line hits never become statement hits. These counters are a
lower bound on proven statement coverage, so the unchanged CRAP formula yields
an explicitly labeled upper bound. Missing or ambiguous proof remains a finding,
not fabricated coverage. Metrics measure the plan's source inventory; clones
remain whole-inventory because they cross file boundaries. Type census measures
only scoped files in the selected projects, retaining complete ownership for
origin attribution. Publisher/store/export findings are scoped to affected
workspaces and consumers; their shared invocation graph and schema inputs remain
complete so cross-file provenance is not severed. Knip selects those workspaces.
Coverage/CRAP use selected lanes, and every changed source must belong to both
the quality scope and a selected coverage lane.

### Proof or measure

Scoped finish requires **every unmeasured baseline path**, including paths with
zero findings, to have a `sha256[path]` content hash equal to the source at head.
Missing proof, missing source, changed hash, stale scope, incomplete metrics, or
missing leg fails closed and names the offending path/leg. Proven baseline
findings are carried forward; no old execution receipt is credited as fresh.
Cross-file clones and schema identities are measured, not carried. Unattributable
growth no longer reports all untouched rows when no changed row owns it.

The baseline index's optional `sha256` map is a **format extension, not a floor
change**. Legacy indexes remain admissible for whole-inventory measurements;
scoped use requires proofs. Initial hashes are recovered from the recorded
admission tree `f01220b4` (#995), not stamped from today's unmeasured working tree.
All finding fragments, values, multiplicities and coverage floors are unchanged.
Adding hashes is not finding growth. A later merged change can invalidate a proof:
remeasure that scope or use the full tier, then refresh proofs from that verified
measurement. Never label changed-but-unmeasured source as unchanged.
Full mutation runs in the explicit `quality-mutation` scheduled/manual workflow,
not in PR admission. It retains failed/incomplete process evidence and fails
closed until a complete campaign and reviewed baseline exist; a missing baseline
is not a zero-survivor claim. A PR pilot is never reported as zero survivors.

Python quality tools are installed from
`script/conformance/quality-python-requirements.txt` under Python 3.12.12.

Ownership is handwritten `.ts`, `.tsx`, and `.py` under `packages/*/src|test`,
`apps/*/src|test`, and `script/`. Handwritten declarations remain type inputs;
`dist`, dependency trees and generated directories never contribute findings.
Configuration, historical SQL and embedded-driver identities remain recorded as
resolver/schema inputs. Product censuses exclude test, fixture, benchmark and
diagnostic-tool roots as product consumers; the tools themselves still participate
in the other quality gates. SQLite-maintained `sqlite_sequence` is intrinsic,
not an owned table requiring an invented application writer.

Quality baseline fragments are exact measured multiplicities by gate, source and
symbol. Both the index and fragments are compared with the Git base: editing a
fragment cannot make growth legal. The initial admission baseline must equal a
complete measurement, without spare allowances; it records debt rather than
claiming convergence. Missing or incomplete measurements always fail.

Once the baseline exists in the Git base, `script/quality-ratchet.ts` attributes
growth to the PR's own changes rather than to paths:

- Changed files come from `git diff --name-status --find-renames` plus untracked
  owned sources. A moved file inherits the baseline recorded under its Git base
  path; hunks are the added/changed line ranges of that base-to-current diff,
  and an added file is entirely new. Deleted paths simply stop matching.
- Findings compare by content identity: gate, mapped path and symbol, with
  anonymous function byte offsets erased (a per-file value multiset) and clone
  clusters keyed by token hash alone. Pre-existing complexity inside a touched
  function is not growth; a worse metric value, or a new function/symbol, is.
  When an identity grows, the rows in changed files are reported.
- The type census labels each top type `owned` or `foreign`. Written `any`/
  `unknown`, owned bindings, parameters and members, and reach through owned
  declarations are owned; reach only through dependency or `lib.*.d.ts`
  declarations (zod internals, `Error.cause`, foreign generic instantiations) is
  foreign and never counts as PR growth. Owned top types on changed lines always
  fail (the literal-zero target); unlabelled rows are owned. The repo-total
  shrink-only baseline is unchanged and still lists every finding.
- Coverage on the PR is the native LCOV evidence itself (the measurement
  bundle's `coverage.json` beside `current.json`, or `--coverage`): every touched
  line of a production or tooling source (not tests, fixtures or benchmarks) must
  have executed in a selected lane; a touched production file with no native
  record owes all of its measured statements. The proof-bit `unproven-statement` class
  remains the whole-repository floor and is no longer ratcheted per statement
  hash, because multi-line statements can never satisfy it. CRAP growth counts
  only where the function contains a natively unexecuted line.

Baseline integrity (fragments versus the Git base) and initial admission keep
the strict path-keyed comparison. `script/quality-ratchet.test.ts` proves each
rule with a passing case and a mutation that flips it.

### Initial measured admission baseline (#945)

The baseline covers 908 owned source files. It was re-measured after the
merge of `main` (#969/#994/#996/#997 landed between the first measurement and
admission) with the same pinned tooling: Bun 1.4.1, Python 3.12.12; its source
inventory hash is
`207f0b8f6a8165ff7210c74dd9b19e344e962121e98edfa3e594ce97442a4c6a`.
The fragments preserve exact measured values and multiplicities, not padding.

| Per-PR finding class | Measured findings |
| --- | ---: |
| Type census | 43,363 |
| Publisher / export / store | 39 / 372 / 5 |
| Cyclomatic / cognitive / Halstead | 16 / 11 / 0 |
| CRAP upper bound | 1,280 |
| Production clone occurrences | 74 (36 clusters) |
| Test clone occurrences | 560 (272 clusters) |
| Unproven original statements | 54,335 |

The script line floor increases from 34.11% to **55.71%** (7,519 of 13,497
owned lines). First measured Linux floors are machines 90.49%, UI 92.93%, and
desktop 92.96%. The existing line ratchet retains its 0.5 percentage-point
platform tolerance; the finding ratchet does not grant a growth tolerance.
These are admission baselines, not achievement of the final zero/100% targets.
Full mutation has no fabricated baseline or zero-survivor claim: the scheduled
lane requires a complete campaign and reviewed measurement before admission.

The manifest partitions the recursive script tests without losing conformance
or tooling tests. Script coverage merges partitions before applying its floor.

`Test` and `CI` are stable completion checks. They run even after upstream
failure and reject failed, cancelled, missing, or unexpectedly skipped jobs.
Only skips justified by the plan and event are accepted; contracts remain required
for docs-only/empty plans, and tooling coverage is required only for tooling/full plans. Configure
the repository ruleset to require `CI`; adding the workflow does not itself
change GitHub branch protection. Benchmark checks are post-merge checks and
must not be required for PR admission.

## Desktop smoke

The desktop lane includes built-output CSP/preload contracts in its Bun tests and
one Playwright production-build smoke when `desktopApp` or `ui` is selected.
Locally, build first and run `mise exec bun@1.4.1 -- bun run --cwd apps/desktop test:e2e`.
On Linux the command must run under `xvfb-run -a`; macOS can run it directly.
CI reuses the prepared `workspace-dist.tar` and caches Electron's binary only in
this smoke job.

## Local reproduction

Use the pinned Bun version, a clean build, and the same commands as CI:

```bash
b() { mise exec bun@1.4.1 -- bun "$@"; }
b install --frozen-lockfile
b run ci build
b run script/ci-plan.ts --full > ci-plan.json
b run lint
b run script/check-topology.ts
b run script/check-deps.ts
b run script/check-import-cycles.ts
b run script/check-dead-exports.ts
b run script/verify-tsconfig-inheritance.ts
b run script/verify-ledger-rename.ts
b run script/check-ledger-schema-drift.ts
```

For measured quality, use Python 3.12.12 and Node 24.19.0 as in CI. Start from
fresh lane coverage directories and a new receipt directory: `begin` rejects
pre-existing LCOV. The following uses `jq` to run every selected lane, wrapping
coverage lanes with receipts bound to the same run identity. Do not change owned
sources between collection, tests, and finish.

```bash
set -euo pipefail
python -m pip install --requirement script/conformance/quality-python-requirements.txt
export D945_PYTHON="$(command -v python)"
export PYTHONDONTWRITEBYTECODE=1
QUALITY_RUN="local:$(uuidgen):$(git rev-parse HEAD)"
QUALITY_BASE=origin/main
mkdir quality-receipts
for leg in types publisher export store metrics; do
  b run script/quality-measure.ts collect --leg "$leg" --plan ci-plan.json --output quality-legs
done
# Workspace lanes keep their original receipts and per-lane floors.
while IFS=$'\t' read -r key lane; do
  receipt="quality-receipts/${lane//\//-}.json"
  b run script/quality-coverage-record.ts begin --lane "$lane" --run "$QUALITY_RUN" --output "$receipt"
  b run ci test --lane "$key"
  b run script/quality-coverage-record.ts finish --lane "$lane" --run "$QUALITY_RUN" --output "$receipt"
done < <(jq -r '.matrix.include[] | select(.dir != "script") | [.key, .dir] | @tsv' ci-plan.json)
if [[ "$(jq -r .toolingTests ci-plan.json)" == true ]]; then
  mkdir quality-partitions
  for part in scripts-contracts scripts-tooling-1 scripts-tooling-2 scripts-tooling-3; do
    b run script/quality-coverage-record.ts begin --lane script --partition "$part" --run "$QUALITY_RUN" --output "quality-partitions/$part.json"
    b run ci test --lane "$part"
    b run script/quality-coverage-record.ts finish --lane script --partition "$part" --run "$QUALITY_RUN" --output "quality-partitions/$part.json"
    mv script/coverage "quality-partitions/$part-coverage"
  done
  b run script/quality-coverage-record.ts merge --lane script --directory quality-partitions --run "$QUALITY_RUN" --output quality-receipts/script.json
  b run script/check-coverage-ratchet.ts --lane script
else
  b run ci test --lane scripts-contracts
fi
b run script/check-quality-python.ts
b run script/quality-measure.ts finish --legs quality-legs --base "$QUALITY_BASE" \
  --baseline script/conformance/quality-baseline-lcov-bound.json --plan ci-plan.json \
  --run "$QUALITY_RUN" --coverage-directory quality-receipts --output quality-results
```

The planner accepts `--base <full-SHA> --head <full-SHA>` for a local change
comparison. Save its JSON output and pass the path to
`bun run ci check-types --plan <file>`. On GitHub non-PR events the planner
intentionally selects everything.

`bun test --timeout 15000` remains a useful local test command, but is not
equivalent to all CI gates. `bun run ci test --lane <key>` matches a CI lane,
including workspace coverage checks. Script partitions instead require the merge
and floor commands above. Do not use a cached Turbo test result as evidence
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
