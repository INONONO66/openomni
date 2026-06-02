# Dispatch / Policy Verification Matrix

Task 5 verification record for team goal `G001-add-protocol-dispatch-schemas-events`.

## Scope

Verified the dispatch-schema, canonical policy timing, inbound-message compatibility,
worker IPC, resident routing, and subagent policy-admission surfaces that are most
likely to be affected by dispatch protocol changes.

## Commands and results

| Check | Command | Result | Notes |
| --- | --- | --- | --- |
| Dependency bootstrap | `bun install` | PASS | Installed workspace dependencies after initial `turbo: command not found`; no lockfile changes. |
| Full typecheck | `bun run check-types` | PASS | Turbo reported 10/10 successful tasks. |
| Full tests | `bun run test` | PASS | Turbo reported 9/9 successful tasks. Agent conformance suite includes 10 documented skipped known-ungoverned policy paths. |
| Repo lint | `bun run lint` | PASS | Guard lint and side-effect lint passed. Biome exited 0 with 12 pre-existing warnings in tests/runtime files. |
| Protocol dispatch/policy targets | `bun test packages/protocol/test/policy.test.ts packages/protocol/test/policy/point-registry.test.ts packages/protocol/test/inbound-message/schema.test.ts packages/protocol/test/agent-execution.test.ts packages/protocol/test/ipc/schema.test.ts` | PASS | 100 pass / 0 fail. Covers canonical policy timings, point registry, inbound-message schemas, execution events, and worker IPC schema preservation. |
| Runtime ingress/delegation targets | `bun test packages/openomni/test/subagent/subagent-spawn-policy.test.ts packages/openomni/test/subagent/descriptor.test.ts packages/openomni/test/resident/runtime.test.ts apps/server/test/ingress-bridge.test.ts apps/server/test/agent-routing.test.ts` | PASS | 31 pass / 0 fail. Covers resident routing, ingress bridge tool surfaces, policy-plan propagation, and subagent worker descriptors. |

## Integration findings

- `packages/protocol/src/policy/definition.ts`, `policy/point-contract.ts`, and
  `policy/point-registry.ts` are coupled and should be changed together whenever
  canonical policy timing or point IDs change.
- `packages/protocol/src/inbound-message/index.ts`, `src/execution/index.ts`,
  and `src/ipc/index.ts` are the schema choke points for dispatch compatibility.
- Runtime adapters most exposed to dispatch changes are:
  - `packages/openomni/src/ingress/handlers.ts`
  - `packages/openomni/src/ingress/middleware/ingress-authority.ts`
  - `packages/openomni/src/execution-runtime/tool/agent/tools/inbound-message.ts`
  - `apps/server/src/ingress/bridge.ts`
  - `apps/server/src/execution/worker-runner.ts`
- The full agent policy no-bypass conformance suite still documents skipped
  known-ungoverned paths. These are existing roadmap gaps, not failures from the
  current verification pass.

## Fix decisions

No integration fix was applied in this lane. The only initial failure was missing
workspace dependencies in this worktree (`turbo: command not found`), resolved by
`bun install`. Subsequent typecheck, test, lint, and focused dispatch/runtime
checks passed.

## Subagent findings integrated

- Test probe confirmed the most relevant broad commands and highlighted missing
  direct model-resolution regressions outside this dispatch-lane scope.
- Change-slice probe identified the coupled protocol policy files, runtime
  adapter hazards, and the exact focused commands used above.
