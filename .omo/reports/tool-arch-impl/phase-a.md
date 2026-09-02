# defineTool phase A implementation report

Base commit: `742e67f3f6b85dec12c1ee837ff03a38290817d3`

## RED capture

The core tests and the base-pinned menu fixture were written before implementation. Running
`bun test apps/openomni/src/tools/core --timeout 15000` produced:

```text
apps/openomni/src/tools/core/dispatch.test.ts:
error: Cannot find module './define'

apps/openomni/src/tools/core/catalog.test.ts:
error: Cannot find module './catalog'

apps/openomni/src/tools/core/project.test.ts:
error: Cannot find module './define'

0 pass
3 fail
3 errors
```

The migrated artifact and memory behavior tests were also changed before implementation to route
refusals through the dispatcher and require `isError: true`.

## Research deltas R1-R4

- R1: `project.test.ts` pins field-level `.describe()` preservation in derived JSON Schema.
- R2: dispatcher error results carry the closed internal classification
  `unknown_tool | invalid_input | precondition_failed | execution_failed | invalid_output`; unit
  tests cover every class. No `packages/llm` code changed.
- R3: `ToolDefinition.inputExamples` is optional and every example is parsed at construction;
  synthetic valid and invalid definitions are tested.
- R4: catalog order follows `TOOL_DEFINITIONS` deterministically. The snapshot harness makes each
  menu twice, pins ordered names from base, and checks SHA-256 fingerprints over projector version
  1 plus the ordered names.

## Wire-schema comparison

Base and new snapshots were generated with `collectToolSpecs()` before and after implementation.
Their textual SHA-256 values are:

- base: `9659ab748bacfa38abfa46e346394a88e55a443d37d4e653ed43a651c71d1988`
- phase A: `c734e5066cd01780ef9b2cefa7c085c4086764f12bc1cc5fe459d6a85c01a856`

For `write_artifact`, `read_artifact`, and `memory`, a recursive key-sorted comparison reports
`migrated schemas semantically identical`. The 91-line textual diff contains only object-key order:
Zod emits `properties`, then `required`, then `additionalProperties`; the old hand schemas emitted
`additionalProperties` and `required` first. Within the optional memory fields, Zod emits
`description` before `type`/`minLength`. No key, value, required field, constraint, enum, or
field-description changed. No `wireProjection` escape hatch was needed for these three tools.

## Verification

All required commands passed in `/Users/ino/Develop/openomni-toolarch`:

- `bun run build` - 5/5 build tasks successful.
- `bunx turbo run check-types` - 15/15 tasks successful.
- `bun test apps/openomni --timeout 15000` - 514 passed, 0 failed across 50 files.

Targeted core plus migrated behavior tests also passed: 52 passed, 0 failed across 5 files.
