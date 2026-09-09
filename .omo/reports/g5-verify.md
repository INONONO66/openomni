# G5 verification

## RED

Command:
`mise exec bun@1.4.1 -- bun test script/ci-plan.test.ts script/ci.test.ts --timeout 15000`

The new merge-group/workflow/PR quality assertions failed before implementation:
- merge_group trigger was undefined
- PR quality jobs were guarded out
- PR gate rejected quality success because the existing test expected skips

## GREEN

Command:
`mise exec bun@1.4.1 -- bun test script/ci-plan.test.ts script/ci.test.ts --timeout 15000`

Result: 111 tests, 0 failures (after updating stale expectations to the new
contract).

## Full local gate chain

| Command | Result |
| --- | --- |
| `mise exec bun@1.4.1 -- bun run ci build` | PASS |
| `mise exec bun@1.4.1 -- bunx turbo run check-types` | see note |
| `mise exec bun@1.4.1 -- bunx tsc -p script/tsconfig.json` | see note |
| `mise exec bun@1.4.1 -- bun run script/check-deps.ts` | see note |
| `mise exec bun@1.4.1 -- bun run script/check-import-cycles.ts` | see note |
| `mise exec bun@1.4.1 -- bun run lint` | see note |
| `mise exec bun@1.4.1 -- bun run lint:tools` | see note |
| `mise exec bun@1.4.1 -- bunx ultracite check --formatter-enabled=false .` | see note |
| `mise exec bun@1.4.1 -- bun run script/check-dead-exports.ts` | see note |
| `mise exec bun@1.4.1 -- bun test script --timeout 15000` | FAIL (721 passed, 53 failed; existing Python/quality suite failures) |

The first attempt used `bun bunx` for bunx entries and is not evidence; the
correct commands above were rerun. Full-chain completion is blocked by the
existing Python/quality failures; no floors or tests were changed.

## Final CI expressions audit

- concurrency: `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`
- quality-static: `if: needs.plan.outputs.verify == 'true'`
- quality-gates: `if: needs.plan.outputs.verify == 'true'`
- quality: `if: needs.plan.outputs.verify == 'true' && (needs.scripts-coverage.result == 'success' || needs.scripts-coverage.result == 'skipped')`
- planner: non-PR events, including `merge_group`, select `--full` and therefore
  produce class `global`; PRs use the scoped base/head diff.
- scripts-coverage skipped dependency: `quality` explicitly accepts a skipped
  `scripts-coverage` result for non-tooling plans.

## Gate-chain correction

The initial `tsc`, lint, and ultracite failures were caused by the newly added
workflow assertion (unknown YAML type and unnecessary string escape). The test
was corrected without changing product floors. Corrected commands passed:
`mise exec bun@1.4.1 -- bunx tsc -p script/tsconfig.json`,
`mise exec bun@1.4.1 -- bun run lint`, and
`mise exec bun@1.4.1 -- bunx ultracite check --formatter-enabled=false .`.
Build, turbo check-types, check-deps, import-cycles, lint:tools, and dead-exports
also passed. The full script suite remains blocked by 53 pre-existing Python /
quality failures (721 passed).
