# PR4b verification

- `mise exec bun@1.4.1 -- bun install --frozen-lockfile`: pass.
- Production build: `mise exec bun@1.4.1 -- bun run --cwd apps/desktop build`: pass; all three electron-vite stages report Vite 8.2.2 and emit main, preload, renderer outputs.
- macOS Playwright Electron smoke: pass, 1 test, 1.8s Playwright summary (2.2s shell elapsed). It launches the built app, checks title, Console.Content layout, CSP directives, bridge keys/versions, no renderer errors, and closes Electron.
- Built-output contracts: RED trial removed `connect-src` from a temporary copy and exited 1; restored artifact then GREEN: 2 pass.
- `bunx turbo run check-types`: pass (16 tasks).
- `bunx tsc -p script/tsconfig.json`: pass.
- `bun run script/check-deps.ts`: pass with the repository's existing stale `packages/ipc/AGENTS.md` warning.
- `bun run script/check-import-cycles.ts`: pass (384 modules, 0 cycles).
- `bun run lint`: pass after directing Playwright output to `/tmp`.
- `bun run lint:tools`: pass.
- `bunx ultracite check --formatter-enabled=false .`: pass.
- `bun run script/check-dead-exports.ts`: pass.
- `bun test apps/desktop packages/ui --timeout 15000`: pass (558 tests).
- `bun test script/ci.test.ts script/ci-plan.test.ts`: pass (81 tests).

No Linux/Xvfb execution was available locally; CI job uses ubuntu-24.04 and xvfb-run.

## CI 34228790020 follow-up

The run failed because Ultracite rejected the empty Playwright fixture pattern and
missing strict mode in `startup.cjs`; fixed with `test.info()` and line-1
`"use strict"`. The smoke also assumed Electron lived under the desktop package;
CI's root Bun store disproved that. The install step now resolves
`electron/package.json` with Bun before running `install.js`. The same resolver
was verified locally and returned `node_modules/.bun/electron@44.1.1/...`.

After rebasing onto main `7b85d9f2`, Ultracite passes with zero errors, the
macOS smoke passes in 3.0s, and all changed-file diagnostics are clean. The
rerun gate chain is blocked by a pre-existing unrelated `packages/agent` type
error: `session-inspection.test.ts:259` supplies unsupported `actionId`.
