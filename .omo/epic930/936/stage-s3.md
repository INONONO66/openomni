# Stage S3 receipt — single L2 executor

## Outcome

Stage 3 centralizes the L2 execution verdict model and tool dispatch helpers in `@openomni/agent`. The executor enforces pre decision, ledger intent, body, post decision, ledger result, then observation; records `policy.decision` children; represents post denial as reverted or irreversible; rejects unregistered kinds with `UnregisteredExecutionKindError`; and accepts extension kinds only as declarative registration data. Tool Started/Completed/TimedOut publication is owned by the executor module and occurs after matching commits. App callback registries and app-owned tool definition/projection/dispatch implementations are absent.

## Commits since stage S2

- `3a0083f4` chore(agent): keep moved dispatcher types concrete Refs #936
- `0bb4d042` fix(test): preserve llm observation sink shape Refs #936
- `3b90ca9d` chore(kernel): remove dead stage three exports Refs #936
- `9fe1d71e` refactor(agent): centralize tool lifecycle observations Refs #936
- `44c0ea6c` fix(agent): type extension kind registration Refs #936
- `6fbfd4b8` wip(agent): s3 executor cut-over in progress
- `87e5f014` refactor(composition): delete callback registries Refs #936
- `1173cd93` refactor(tools): cut app dispatch over to agent Refs #936
- `7c972cc1` refactor(agent): own tool definition helpers Refs #936

## Changed files

- `apps/openomni/src/delegation/worker-loop.ts`
- `apps/openomni/src/index.ts`
- `apps/openomni/src/resident.ts`
- `apps/openomni/src/tools/authority/approval.ts`
- `apps/openomni/src/tools/authority/delegation.ts`
- `apps/openomni/src/tools/cell-registry.test.ts`
- `apps/openomni/src/tools/cell-registry.ts`
- `apps/openomni/src/tools/core/catalog.test.ts`
- `apps/openomni/src/tools/core/catalog.ts`
- `apps/openomni/src/tools/execution/llm.ts`
- `apps/openomni/src/tools/execution/run-code.ts`
- `apps/openomni/src/tools/mutation/provision.ts`
- `apps/openomni/test/approval-adversarial.test.ts`
- `apps/openomni/test/code-mode-e2e.test.ts`
- `apps/openomni/test/delegation-tool-boundaries.test.ts`
- `apps/openomni/test/delegation.test.ts`
- `apps/openomni/test/gateway-contracts.test.ts`
- `apps/openomni/test/helpers/tool-dispatch.ts`
- `apps/openomni/test/model-transport.test.ts`
- `apps/openomni/test/provision-tools.test.ts`
- `apps/openomni/test/resident-compaction.test.ts`
- `apps/openomni/test/resident-llm-resilience.test.ts`
- `apps/openomni/test/rlm-tools.test.ts`
- `packages/agent/src/compaction/policy.ts`
- `packages/agent/src/core/execution/run.ts`
- `packages/agent/src/core/policy/types.ts`
- `packages/agent/src/executor.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/observation/bus.ts`
- `packages/agent/src/tool-dispatcher.ts`
- `packages/agent/test/compaction/speculate.test.ts`
- `packages/agent/test/core/execution/execution-verdicts-model.test.ts`
- `packages/agent/test/core/execution/lifecycle-run-start.test.ts`
- `packages/agent/test/core/execution/lifecycle-turn-pre.test.ts`
- `packages/agent/test/core/execution/overflow-recovery.test.ts`
- `packages/agent/test/core/execution/tool-policy-context.test.ts`
- `packages/agent/test/core/execution/tool-selection.test.ts`
- `packages/agent/test/core/execution/tools-verdicts.test.ts`
- `packages/agent/test/core/execution/turn-yield.test.ts`
- `packages/agent/test/core/policy/conformance/no-bypass.test.ts`
- `packages/agent/test/core/policy/engine.test.ts`
- `packages/agent/test/helpers/policy-decision.ts`
- `packages/channels/test/helpers/observation.ts`
- `packages/ledger/test/helpers/observation.ts`
- `packages/llm/test/helpers/observation.ts`
- `packages/llm/test/processor/emission-measurement.test.ts`
- `packages/policy/src/engine/dispatch.ts`
- `packages/policy/src/engine/registration-validation.ts`
- `packages/policy/src/engine/types.ts`
- `packages/policy/src/index.ts`
- `packages/policy/src/row-compiler.ts`
- `packages/policy/test/canonical-registration-boundary.test.ts`
- `packages/policy/test/canonical-registration.test.ts`
- `packages/policy/test/engine-behavior.test.ts`
- `packages/policy/test/engine-portability.test.ts`
- `packages/policy/test/engine-scope-and-points.test.ts`
- `packages/policy/test/invariant-smoke.test.ts`
- `packages/policy/test/point-audit.test.ts`
- `packages/policy/test/point-context-immutability.test.ts`
- `packages/policy/test/point-dispatch.test.ts`
- `packages/policy/test/point-test-fixtures.ts`
- `packages/policy/test/unguarded-point.test.ts`
- `script/lint-tools.test.ts`
- `script/lint-tools.ts`

## Deleted files

- `apps/openomni/src/composition/driver-registry.ts`
- `apps/openomni/src/composition/policy-registry.ts`
- `apps/openomni/src/tools/core/define.ts`
- `apps/openomni/src/tools/core/dispatch.test.ts`
- `apps/openomni/src/tools/core/dispatch.ts`
- `apps/openomni/src/tools/core/project.test.ts`
- `apps/openomni/src/tools/core/project.ts`
- `apps/openomni/test/driver-registry.test.ts`
- `apps/openomni/test/policy-registry.test.ts`
- `packages/agent/test/core/execution/run-policy-engine.test.ts`
- `packages/agent/test/core/policy/canonical-execution.test.ts`

## Deletion grep-zero

All issue-body deletion commands below exited with no matches; raw stdout was empty for each command.

```text
rg -n 'policy-registry|PolicyRegistry|createPolicyRegistry|MissingMandatoryPolicyError' apps packages --glob '*.ts'
rg --files apps packages | rg '(^|/)policy-registry[.]ts$'
rg -n 'driver-registry|DriverRegistry|createDriverRegistry' apps packages --glob '*.ts'
rg --files apps packages | rg '(^|/)driver-registry[.]ts$'
rg -n 'tools/core/(define|project|dispatch)|[.][.]/core/(define|project|dispatch)|[.]/(define|project|dispatch)' apps packages --glob '*.ts'
rg --files apps/openomni/src/tools/core | rg '/(define|project|dispatch)[.]ts$'
rg -n 'stableStringify|mergeEntries' packages/policy/src --glob '*.ts' --glob '!*.test.ts' --glob '!dist/**'
rg -n 'PolicyRegistrationFactoryGeneric|createForRun|onRunEnd|engine[.]register[(]' apps packages --glob '*.ts'
rg --files apps packages | rg '(^|/)(policy-registry|registration-factory|dispatch|project)[.]test[.]ts$'
```

Tool lifecycle production census:

```text
$ rg -n 'Tool[.]Events[.](Started|Completed|TimedOut)' packages apps --glob '*.ts' --glob '!*.test.ts' --glob '!dist/**'
packages/agent/src/executor.ts:103:      scoped(context)?.publish(Tool.Events.Started, {
packages/agent/src/executor.ts:114:      scoped(context)?.publish(Tool.Events.Completed, {
packages/agent/src/executor.ts:126:      scoped(context)?.publish(Tool.Events.TimedOut, {
```

## Dead exports

```text
$ bun run script/check-dead-exports.ts
OK: dead-export ratchet — 11 topology workspaces scanned, 0 known issues, none new
```

## GREEN verification

```text
$ bunx turbo run check-types
Tasks:    15 successful, 15 total
Cached:   12 cached, 15 total
Time:     11.768s

$ bun test --timeout 15000
2817 pass
0 fail
12184 expect() calls
Ran 2817 tests across 310 files. [65.00s]
```

The package-focused run also completed with 421 pass / 0 fail. No pre-existing failures were observed.
