# defineTool phase B implementation report

Base commit: `742e67f3f6b85dec12c1ee837ff03a38290817d3`

## Result

All 28 catalog tools are now `defineTool` definitions in `query/`, `mutation/`, `authority/`, or `execution/`. The Phase A legacy catalog bridge is deleted. Catalog-bound executors accept parsed values and return typed domain values; rendering is performed by each definition, and domain precondition failures use `ToolRefused`.

`complete_work` and `delegate` both carry construction-validated `inputExamples`. `run_code` retains its `machineId` input and wire shape. The three filesystem tools use machine execution with capability `fs.read` while retaining explicit host placement for menu parity; `run_code` uses machine execution with `kernel.py`.

The base-pinned menu fixture now exercises the full catalog for both doors, both roles, and full/empty ports. All eight cases match base ordering and fingerprints.

## Wire schema comparison

Snapshots were generated from base `742e67f3` and this Phase B tree. Their textual SHA-256 values are:

- base: `9659ab748bacfa38abfa46e346394a88e55a443d37d4e653ed43a651c71d1988`
- Phase B: `902e3d15506a8eaa486bd814f8cb9fd64ae4eb9b9027b82871c1d25efeb4d294`

Per-tool review:

| Tool | Comparison with base wire schema |
|---|---|
| `delegate` | Identical; exact flat object `wireProjection` retained because the preprocessed/refined input derives a non-object root rejected by Anthropic. |
| `await_delegation` | Equivalent; derived schema adds the Zod/JS safe-integer maximum to `timeoutMs`. |
| `cancel_delegation` | Identical. |
| `converse_open` | Equivalent; derived schema adds existing Zod field descriptions and safe-integer maxima. |
| `converse_close` | Equivalent; derived schema adds the existing field description. |
| `lease_open` | Equivalent; derived schema adds existing field descriptions and a safe-integer maximum. |
| `approval_request` | Identical; exact flat object `wireProjection` retained because the discriminated union derives a non-object root. |
| `approval_decide` | Equivalent; derived schema adds existing field descriptions. |
| `contact_promote` | Equivalent; derived schema adds the existing field description. |
| `endpoint_merge` | Equivalent; derived schema adds the existing field description. |
| `person_declare` | Equivalent; derived schema adds existing descriptions, safe-integer maximum, and reverses enum presentation order without changing members. |
| `person_remove` | Identical. |
| `channel_declare` | Equivalent; derived schema exposes Zod defaults/descriptions and redundant string `propertyNames` constraints. Required fields and accepted values are unchanged. |
| `channel_enable` | Identical. |
| `channel_disable` | Identical. |
| `secret_rotate` | Equivalent; derived schema adds the existing description and redundant string `propertyNames` constraint. |
| `provision_status` | Equivalent; derived empty-object schema omits the base schema's no-op `required: []`. |
| `run_code` | Equivalent; derived schema adds the Zod/JS safe-integer maximum to `timeoutMs`; `machineId`, `code`, and `timeoutMs` remain the exact required wire fields. |
| `machines` | Identical. |
| `fs_read` | Identical; exact `wireProjection` prevents machine auto-injection because machine identity remains embedded in `path`. |
| `fs_list` | Identical; same path-embedded-machine projection. |
| `fs_stat` | Identical; same path-embedded-machine projection. |
| `memory` | Identical (Phase A). |
| `work_items` | Identical. |
| `complete_work` | Equivalent; the judgment description moves from the array node to its union item, with constraints and accepted values unchanged. |
| `llm` | Identical; exact `wireProjection` prevents machine auto-injection because this host-bound execution tool has no machine selector. |
| `write_artifact` | Identical (Phase A). |
| `read_artifact` | Identical (Phase A). |

All differences are descriptive, ordering/presentation, redundant JSON-object constraints, or constraints already enforced by the Zod runtime. No accepted runtime input was widened and no legacy wire field was added or removed.

## `wireProjection` uses

- `delegate`: exact former hand schema; required Anthropic root-object compatibility escape hatch.
- `approval_request`: exact former flat hand schema; required for the root discriminated union.
- `fs_read`, `fs_list`, `fs_stat`: exact former hand schemas; prevent the generic optional `machine` injection because these tools address machines inside `path`.
- `llm`: exact former hand schema; prevents optional `machine` injection while preserving its existing one-field wire contract.

## Deletion proof

```text
$ git grep -n "INPUT_JSON_SCHEMA\|ToolSpec(" apps/openomni/src
<no output>
exit 1

$ test ! -e apps/openomni/src/tools/provision-specs.ts
exit 0

$ rg -n "PHASE-A BRIDGE|LegacyCatalogTool|CATALOG_TOOLS|readonly wire:" apps/openomni/src/tools
<no output>
exit 1
```

The only `safeParse` under `src/tools` is the central validation call in `core/dispatch.ts`; no tool executor has a `safeParse` prologue. Schema-mirror tests for deleted hand schemas were removed.

## Verification

Executed in `/Users/ino/Develop/openomni-toolarch` after the final changes:

- language-server diagnostics on `apps/openomni/src/tools` and `apps/openomni/test`: 0 errors.
- `bun run build`: passed.
- `bunx turbo run check-types`: 15/15 tasks passed.
- `bun test apps/openomni --timeout 15000`: 511 passed, 0 failed across 50 files.
- full catalog menu parity: 8 passed, 0 failed.

`bun run lint:tools` was intentionally not run because Phase C owns its rewrite, as directed.
