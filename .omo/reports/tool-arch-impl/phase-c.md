# defineTool phase C implementation report

## Result

`script/lint-tools.ts` now imports the real `TOOL_DEFINITIONS` and `collectToolSpecs` exports from `apps/openomni/src/tools/core/catalog.ts`. The legacy `ToolSpec` factory regex and catalog-row source matching are deleted.

The runtime definition checks now enforce:

- every exported definition is present in `TOOL_DEFINITIONS`, and every catalog definition resolves to an exported source declaration;
- source directory matches `query`, `mutation`, `authority`, or `execution` category;
- query definitions are safe;
- execution definitions have machine execution locus;
- names are non-empty and unique;
- descriptions are non-empty;
- existing tool naming and public-field budgets still apply to the derived specs.

The top-level field counter now resolves local JSON Schema `$ref` pointers and combines `allOf`, `anyOf`, and `oneOf` branches. Its discrimination self-test includes a composed `$ref`/`allOf`/`anyOf` fixture.

The unrelated protocol evolution snapshot remains in place and unchanged. A new exact snapshot at `script/conformance/tool-schema-snapshot.json` records all 28 derived `Tool.Spec` values in catalog order. `--update` regenerates both snapshots; only the new derived-tool snapshot from the authorized Phase B wire review is committed.

## Snapshot regeneration

```text
$ bun run script/lint-tools.ts --update
OK: snapshots regenerated (228 protocol types, 28 derived tool specs) — these diffs are the review surface
```

The incidental additive protocol snapshot rewrite was restored before commit because this phase authorized only the derived tool snapshot.

## Mutation proof

A local, uncommitted mutation changed `readArtifactTool.safe` from `true` to `false`.

```text
$ bun run lint:tools
$ bun run script/lint-tools.ts
VIOLATION [tool-lint] read_artifact — [query-safe] query tools must be safe
VIOLATION [tool-schema-snapshot] TOOL_DEFINITIONS — derived tool specs differ from the reviewed snapshot (before: delegate, await_delegation, cancel_delegation, converse_open, converse_close, lease_open, approval_request, approval_decide, contact_promote, endpoint_merge, person_declare, person_remove, channel_declare, channel_enable, channel_disable, secret_rotate, provision_status, run_code, machines, fs_read, fs_list, fs_stat, memory, work_items, complete_work, llm, write_artifact, read_artifact; now: delegate, await_delegation, cancel_delegation, converse_open, converse_close, lease_open, approval_request, approval_decide, contact_promote, endpoint_merge, person_declare, person_remove, channel_declare, channel_enable, channel_disable, secret_rotate, provision_status, run_code, machines, fs_read, fs_list, fs_stat, memory, work_items, complete_work, llm, write_artifact, read_artifact) — run --update only with review authorization
error: script "lint:tools" exited with code 1
```

Exit status was `1`. The source file was restored byte-for-byte immediately afterward; `git diff -- apps/openomni/src/tools/query/artifacts.ts` produced no output.

## Green verification

```text
$ bun run lint:tools
$ bun run script/lint-tools.ts
OK: conformance lint — vocab ratchet, definition invariants, tool lint, naming, earned, protocol schema snapshot, derived tool snapshot

$ bunx tsc -p script/tsconfig.json
<no output; exit 0>

$ bun run script/lint-tools.ts --self-test
OK: lint-tools self-test — all checks discriminate on known-bad fixtures

$ bun run lint:guards
$ bun run script/lint-guards.ts
OK: guard lint scanned 802 TypeScript files

$ bun run lint
$ bun run lint:guards && bun run lint:side-effects && bun run lint:docs && bunx ultracite check --formatter-enabled=false .
$ bun run script/lint-guards.ts
OK: guard lint scanned 802 TypeScript files
$ bun run script/lint-side-effects.ts
OK: side-effect lint scanned 2 hot files
$ bun run script/generate-agents-deps.ts --check
AGENTS.md dependency topology is current
Checked 896 files in 260ms. No fixes applied.
```

Language-server diagnostics reported no issue before formatting; the final TypeScript compiler and Ultracite runs were clean.
