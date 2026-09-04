# #936 Stage S2 receipt

Status: complete on `kernel/936`.

## What changed

- Kept the ledger-row compiler as the package root policy surface: generation-pinned, immutable, content-addressed snapshots hashed with protocol `canonicalDigest`.
- Compiled one precomputed `kind/phase/op|*` bucket per lookup, sorted once by descending priority with deterministic name tie-breaking; evaluation short-circuits on deny/approval and performs zero storage reads.
- Enforced the closed mandatory `RuleName` list (`compaction`) at compilation and converted load/compile failures into deny-all pinned snapshots.
- Closed transformer and obligation names in the row schema (`redact`, `budget_clamp`); unknown names produce typed `PolicyCompileError` machine fields, and redaction now resolves only complete object paths.
- Pinned seeded row values for continuation 8, fanout 8, exact repeat 3, toolless stall 3, blocked recurrence 3, and resume budget 10.
- Removed the policy-root callback engine/registration exports, `PolicyRegistrationError` re-export, callback registration factory test, `legacy_timing_registration` classification, `hasCanonicalFields`, and the `PolicyDecision` alias. Legacy engine consumers now use the internal path until their later production-cutover stage.
- Removed the policy-local `mergeEntries` symbol/test seam; the legacy effect composer retains its internal fold under a non-public name while compiled rows use one-stage bucket matching.
- Added a 220-row / 100,000-evaluation hot-path benchmark with a p50 assertion below 20 microseconds and an exact zero-storage-read assertion.

## RED evidence

Stage S1 established the failing-first policy contracts before implementation. Raw output remains in `.omo/epic930/936/red.txt`:

```text
Export named 'createPolicyCompiler' not found in .../packages/policy/src/index.ts
0 pass
7 fail
Ran 7 tests across 7 files. [90.00ms]
```

During S2 surface deletion, the first type check correctly exposed every remaining root-barrel callback consumer before those imports were moved to the internal legacy path:

```text
Module '"@openomni/policy"' has no exported member 'PolicyEngine'.
Module '"@openomni/policy"' has no exported member 'PolicyRegistrationFactoryGeneric'.
Failed: @openomni/agent#check-types
```

## GREEN evidence

Focused policy command:

```text
bun test --timeout 15000 packages/policy/test/engine-determinism.test.ts packages/policy/test/point-enforcement.test.ts
13 pass
0 fail
38 expect() calls
Ran 13 tests across 2 files. [78.00ms]
```

Type gate:

```text
bunx turbo run check-types
Tasks: 15 successful, 15 total
Time: 142ms (fully cached rerun)
```

Deletion checks:

```text
rg -n 'stableStringify|mergeEntries|legacy_timing_registration|hasCanonicalFields' packages/policy/src --glob '*.ts' --glob '!dist/**'
# no stdout

rg -n 'PolicyRegistrationError' packages/policy/src/index.ts
# no stdout

test ! -e packages/policy/test/registration-factory.test.ts
# exit 0
```

## Bucket benchmark

Command:

```text
bun test --timeout 30000 ./packages/policy/test/bucket-lookup.bench.ts
```

Recorded on Apple M5 Pro / Bun 1.3.6:

```text
policy bucket benchmark: rows=220 evaluations=100000 p50=2.370us storageReads=0
1 pass
0 fail
```

Threshold: p50 `< 20us`; result: PASS.

## Commits

```text
a87b9d3e fix(policy): resolve redaction paths exactly (Refs #936)
a31871da fix(policy): snapshot caller-owned row metadata (Refs #936)
64336da3 fix(policy): make compaction mandatory unconditionally (Refs #936)
e4985753 test(policy): pin seeded kernel limits (Refs #936)
7a234166 refactor(policy): close compiler name unions (Refs #936)
6c35c22d refactor(policy): narrow legacy registration surface (Refs #936)
d13e9d4a test(policy): benchmark compiled bucket lookup (Refs #936)
```
