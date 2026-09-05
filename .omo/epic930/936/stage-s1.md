# #936 Stage S1 receipt

Status: complete on `kernel/936`.

## What changed

- Added failing-first contracts for deterministic policy generations, mandatory/fail-closed compilation, bucket isolation, the four-kind execution verdict matrix, ledger-first policy audit, typed tool post-processing, executor-owned tool observations, and scoped identity precedence.
- Added the policy-row compiler and immutable generation snapshots, including canonical content/input hashes, copy-on-write append, one-stage priority matching, deny short-circuiting, `redact`, `budget_clamp`, and the owner-selected seeded limits.
- Added the agent execution, tool-dispatch, and scoped observation surfaces needed to make the Stage S1 contracts green.
- Moved the `ObservationSink` contract to protocol, moved in-process bus/scope ownership to agent, kept the app observation adapter in `apps/openomni/src/observation`, deleted trace-header handling, and removed `packages/telemetry`.
- Removed telemetry dependencies and topology/CI/knip/coverage entries, regenerated the root topology block, and replaced lower-layer telemetry test imports with package-local test helpers so production dependency direction stays acyclic.
- Renamed the executor action-write port to `commit`, preventing the decision-stream producer scanner from mistaking L0 action commits for raw stream appends.

## RED evidence

Raw output: `.omo/epic930/936/red.txt`.

After the baseline build, all seven new contract files failed before implementation (`0 pass`, `7 fail`). The expected missing surfaces included:

```text
Export named 'createPolicyCompiler' not found in .../packages/policy/src/index.ts
Export named 'createExecutor' not found in .../packages/agent/src/index.ts
Export named 'createDispatcher' not found in .../packages/agent/src/index.ts
Export named 'scopeObservation' not found in .../packages/agent/src/index.ts
Ran 7 tests across 7 files. [90.00ms]
```

## GREEN evidence

Raw output: `.omo/epic930/936/green.txt`.

```text
Policy contracts: 10 pass, 0 fail; 29 expect() calls; 2 files
Agent contracts:  23 pass, 0 fail; 73 expect() calls; 5 files
```

## Verification

- `bun run build`: 6 successful build tasks, exit 0.
- `bunx turbo run check-types`: 15 successful tasks across 11 workspaces, exit 0.
- `bun test --timeout 15000`: 2850 pass, 0 fail, 12260 assertions across 317 files.
- `bun run script/check-topology.ts`: 11-workspace topology conformance, exit 0.
- `bun run script/check-deps.ts`: no violations; only the pre-existing stale-doc notices for IPC and placement.
- `bun run script/check-import-cycles.ts`: 329 modules, 0 value-import cycles.
- `rg -n '@openomni/telemetry|packages/telemetry' . --glob '!node_modules' --glob '!dist/**'`: no stdout / 0 hits.
- `packages/telemetry`: absent.

Implementation commits through `d2cc78f0`:

```text
d2cc78f0 fix(agent): distinguish action commits from stream appends (Refs #936)
62ed3839 refactor(observation): demote telemetry into kernel (Refs #936)
e576f7d7 feat(agent): centralize execution and tool dispatch (Refs #936)
df9dbbce feat(policy): compile deterministic policy snapshots (Refs #936)
a72c55d8 test(agent): sharpen executor observation contracts (Refs #936)
662cc09b test(kernel): pin compiled execution contracts (Refs #936)
```

## Stage boundary

This is the requested S1 handoff, not the final #936 completion receipt. Later stages still own production cutover/deletion of the legacy app policy/driver/tool paths and final issue-level dead-export and zero-added-`unknown` cleanup.
