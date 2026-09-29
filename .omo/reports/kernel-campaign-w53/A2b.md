# W5.3 lane A2b receipt

Date: 2026-09-29  
Worktree: `/Users/ino/Develop/openomni-w53`  
Branch: `kernel/1113-w5-closure-20260929`  
Base: `8390912c`  
Commit/push: none

## Outcomes

### Protocol written-type sites

- `packages/protocol/src/event/operational.ts:24`
  - Replaced `Readonly<Record<string, unknown>>` with
    `Readonly<Record<string, PlainValue>>`.
  - Existing operational-log producers were inspected; their contexts contain
    JSON-compatible scalars, arrays, and objects.
- `packages/protocol/src/ingress/index.ts:63`
  - Replaced the object cast and manual narrowing with
    `LegacyTargetSchema.safeParse`.
  - The existing ingress regression for `{ type: "worker" }` still proves the
    legacy rewrite to `{ kind: "worker" }`.
- `packages/protocol/src/ipc/index.ts:98`
  - Replaced `Record<string, unknown>` with `Request["params"]`.
- `packages/protocol/src/ipc/index.ts:113`
  - Replaced `Record<string, unknown>` with `Notification["params"]`.

Forced consumer edits: none.

The exported Zod schemas did not change shape. Neither
`script/conformance/schema-snapshot.json` nor
`script/conformance/tool-schema-snapshot.json` changed.

### Session retry tests

- Removed the two obsolete `Retry.sleep` spies from
  `packages/agent/test/session-chat-runner.test.ts`.
- The fixture already injects `nullRetryAlarm`; it acknowledges the durable
  retry schedule immediately without sleeping.
- The retry regression still asserts two attempt intents share one logical LLM
  intent parent, and each attempt result belongs to its corresponding attempt
  intent.

## Verification

All commands used Bun 1.4.1 in the assigned worktree:

```text
$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bun run --cwd packages/protocol check-types
$ tsc --noEmit && tsc --noEmit -p tsconfig.test.json
exit 0

$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bun test packages/protocol packages/agent/test/session-chat-runner.test.ts packages/ipc packages/channels
1178 pass
0 fail
4626 expect() calls
Ran 1178 tests across 95 files. [49.98s]
exit 0

$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bun run check-types
Tasks: 17 successful, 17 total
exit 0
```

Root type-check residual errors: none.

```text
$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bun run script/check-written-types.ts
OK: written any/unknown types: 0
exit 0
```

Protocol sites: zero. Other remaining sites: zero (the concurrent A3b gate
landed before this final run).

```text
$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bun run script/lint-tools.ts
OK: conformance lint — vocab ratchet, definition invariants, tool lint, naming, earned, protocol schema snapshot, derived tool snapshot
exit 0

$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bunx ultracite check --formatter-enabled=false packages/protocol/src/event/operational.ts packages/protocol/src/ingress/index.ts packages/protocol/src/ipc/index.ts packages/agent/test/session-chat-runner.test.ts
Checked 4 files in 50ms. No fixes applied.
exit 0

$ mise exec --cd /Users/ino/Develop/openomni-w53 bun@1.4.1 -- bun test packages/agent/test/session-chat-runner.test.ts
9 pass
0 fail
36 expect() calls
Ran 9 tests across 1 file. [1.56s]
exit 0

$ git -C /Users/ino/Develop/openomni-w53 diff --check -- packages/protocol/src/event/operational.ts packages/protocol/src/ingress/index.ts packages/protocol/src/ipc/index.ts packages/agent/test/session-chat-runner.test.ts .omo/reports/kernel-campaign-w53/A2b.md
exit 0
```

LSP diagnostics reported no error in `ingress/index.ts`. Fresh diagnostics
timed out for `event/operational.ts` and `ipc/index.ts`; the authoritative
protocol and root TypeScript checks above passed. The test-file LSP used the
production project and consequently reported its known `bun:test`, `rootDir`,
and DOM-library errors; the package test tsconfig and focused Bun run passed.

## Changed files

- `packages/protocol/src/event/operational.ts`
- `packages/protocol/src/ingress/index.ts`
- `packages/protocol/src/ipc/index.ts`
- `packages/agent/test/session-chat-runner.test.ts`
- `.omo/reports/kernel-campaign-w53/A2b.md`
