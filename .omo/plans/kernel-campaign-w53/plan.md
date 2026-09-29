# W5.3 #1113 — campaign closure PR (worktree openomni-w53, branch kernel/1113-w5-closure-20260929)

Base: origin/main 8390912c (W5.2 #1197 merged). Storage/entity rows of #1113 are superseded by #1197.
Measured on base (2026-09-29): runner-site allowlist 48 (all test-only); any/unknown 49 prod+script sites
(protocol 16, script 20, apps 8, others 5); SLOP open rows owned here: E3 E4 E5 H12 H13 H16 H17 H18 H19 +
973-contract-checker; quality-audit totals (main, 2026-09-28): coverage 3116, complexity 17, clones 280, types 2779;
quality-mutation.yml fails every shard since 2026-09-26 with `baseline compiler rejected 2 diagnostics` (6424 candidates).
#1097 and #1101 are already CLOSED; #945, #1049, #1112 OPEN.

## Laws (binding on every lane)
- No commit to main; lanes edit in this worktree only, never commit or push (parent commits per lane after verification).
- Own files only (listed per lane). Out-of-scope edits are defects. No production behavior change unless the lane says so.
- No `any`/`unknown` introduced; no `as` casts or suppressions to reach zero; boundaries parse into schema-typed values.
- Tests: exact events/state, no sleeps/polls; no prose tests. Deleted code must be grep-zero, not renamed.
- Every lane writes `.omo/reports/kernel-campaign-w53/<lane>.md` with commands run + exit codes + before/after numbers.
- Gate per lane: `mise exec bun@1.4.1 -- bun run check-types` (packages you touched), `bunx ultracite check --formatter-enabled=false <files>`,
  `bun test <touched package/test dirs>`. Other lanes edit concurrently; transient failures in files you do not own are not yours — report them.

## Lanes (wave A, parallel)
- A1 runner-sites-zero: `script/conformance/effect-runner-sites.json` 48 → deleted; `script/check-effect-boundaries.ts --strict` exit 0 with empty allowlist;
  per-package test `isolated`/`runEffect` helper is the only runner owner (counted). Owns: `packages/*/test/**`, `apps/openomni/test/**`, `script/check-effect-boundaries.ts`, the json.
- A2 protocol-census: delete the 42 consumer-zero protocol exports (app-connector 9/12, event/mcp + mcp, provisioning 8/14, policy 5/13, machine 5/37, tool 2/7,
  transcript 2/8, ingress 2/12, platform EntropySource, gateway MessageContract, ledger EncodedPayload, json isPlainValue) and their tests; re-measure with an AST census
  (import identity, not names; barrel re-exports are not consumers). Also drive protocol `any/unknown` 16 → 0 (policy-point.ts 6, error/index.ts 5, json.ts 4, ipc/index.ts 1).
  Owns: `packages/protocol/**`, `script/conformance/schema-snapshot.json` regen, knip baseline shrink only. Closes H12, H13 (protocol part).
- A3 unknown-zero-nonprotocol: 33 sites → 0 in `script/*.ts` (lint-tools 7, check-dead-exports 6, check-deps 3, verify-tsconfig-inheritance, topology, lint-side-effects, lint-guards),
  `apps/openomni/src/{observation/llm-failure.ts 5, tools/send-message.ts, config.ts}`, `apps/desktop/src/preload/index.ts`, `packages/ui/src/primitives/button.tsx`,
  `packages/policy/src/row-compiler.ts`, `packages/ipc/src/framing.ts`, `packages/channels/src/router/{resolve-route,index}.ts`. Then extend `script/check-types-census`
  (or the existing type census in quality-audit) so written `any`/`unknown` in owned src is a hard zero gate. Closes E4.
- A4 read-model: bounded history/inspect reads + gateway snapshot/high-water cursor; new `apps/openomni/test/session-cursor.test.ts`,
  `packages/agent/test/attempt-metrics.test.ts` (provenance reported/estimated/unknown, failed usage once, parallel tool wall vs sum),
  `apps/desktop/test/session-read-model.test.ts`; delete desktop provisional phase/attention authority + `DEFAULT_PROJECT_ID`/Memory residue (H16), keep UI-local state.
  Owns: `packages/agent/src/session-lifecycle/**`, `packages/agent/src/session-handle.ts`, `apps/openomni/src/gateway*.ts` read handlers, `apps/desktop/src/renderer/**`, `packages/ui` consumers of removed exports. Wire DTO changes must stay plain data and be listed in the receipt.
- A5 quality-tooling: (a) fix `quality-mutation.yml` baseline (`baseline compiler rejected 2 diagnostics`, run 36400417999) so shards execute; (b) add cyclomatic, Halstead difficulty and CRAP
  dimensions to `script/quality-audit.ts` with tool version + algorithm pinned in `script/conformance/quality-contract.json`; (c) `script/census-consumer-contract.test.ts` (event without publisher,
  export used only by test/barrel, store only registered, alias collision → fail); (d) H17 receipt: `quality-json.ts`/`quality-native-lcov.ts` sole parsers. Owns: `script/quality-*.ts`, `script/run-quality-mutations*.ts`,
  `script/check-dead-exports.ts` census rules, `.github/workflows/quality-*.yml`, `script/conformance/quality-*.json`, `docs/ci.md`.
- A6 residue-and-nits: W4 #1112 zero-residue audit receipt (llm retry/maxSteps, agent abort listeners, channels reconnect-backoff, composer entry points) with H10 disposition;
  `script/check-deps.ts` allowlist: remove the +6 ledger factory names from the channels perimeter or justify each; agent nits from W5.2 review (reaper interval ≥5s constant, `ConfigProvider.fromEnv` at app edge only,
  `turnId:"noop"` sentinel → typed); H18 stale comments (gateway/schema.ts, transcript/index.ts, provider/contract.ts, resolve-route.ts, github/surface.ts); H19 record `docs/DESIGN.md` absent.
  Owns: `packages/llm/src/retry/**`, `packages/agent/src/{executor-*,tool-body,session-controller}.ts`, `packages/channels/src/support/**`, `apps/openomni/src/composition/**`, `script/check-deps.ts`, listed comment sites, `docs/SLOP.md` rows H10/H18/H19.

## Wave B (parent): full chain, fresh `quality-audit.ts --dry-run` numbers, docs sync (implementation-status, kernel-references, SLOP rows E3/E4/E5/H12/H13/H16/H17/H18/H19/973, AGENTS stamp),
adversarial review (ultrabrain) + fix lanes, CI green, `gh pr merge --squash --auto`, receipt on #1113 listing each child issue disposition with numbers. Absolute literal-zero (coverage 3116 / clones 280 / types 2779 /
mutation 6424 candidates) is measured fresh and reported honestly; anything not reaching zero is an Owner decision, never a laundered close.
