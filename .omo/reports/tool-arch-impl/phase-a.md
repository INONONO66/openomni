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

## Wire-schema comparison

Pending implementation comparison against the base snapshot captured from `collectToolSpecs()`.

## Verification

Pending implementation.
