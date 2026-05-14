# Policy Kernel v2 - Notepad

## Learnings

### Project Structure
- Protocol package (`packages/protocol`) is the leaf - schemas only, no runtime logic
- Agent package (`packages/agent`) owns PolicyEngine and evaluator
- OpenOmni package (`packages/openomni`) owns session-backed orchestration
- Coordinator package (`packages/coordinator`) owns worker pool, IPC, recovery

### Existing Types (as of start)
- `Policy.Timing` - 14 flat timing strings
- `Policy.Verdict` - 7-variant discriminated union (continue, skip, abort, retry, transform, inject, deny)
- `Policy.PolicyEffect` - 11 effect types defined
- `Policy.PolicyPoint` - point + allowedEffects + defaultFailPolicy
- `RuntimeResource.Descriptor` - id, kind, labels, capabilities, effects, risk, source, schemaRef, digest, owner

### Key Patterns
- Namespace + Zod duality
- Discriminated unions
- BusEvent.define() for events
- NamedError.create() for errors

### Task 1 Findings (2026-05-14)

#### 3-Tier Point ID Scheme
- Tier 1 (resource domain): `tool`, `prompt`, `delegation`, `session`, `credential`, `connection`, `run`
- Tier 2 (resource subtype): `native`, `mcp`, `context`, `catalog`, `subagent`, `background`, `inbound`, `writeback`, `llm`, `turn`, `completion`, `lifecycle`, `error`
- Tier 3 (lifecycle phase): `pre`, `post`, `error`
- `invoke.prepare` and `invoke.result` are 1:N mappings — they expand to 4 points each based on resource kind

#### Key Design Decisions Made in Spec
- `ActorDescriptor.actorType: "system"` is reserved — policies cannot grant system authority to user/agent actors
- `SessionDescriptor.sessionType` enables policy-level restriction of self-loop sessions creating top-level inbound work
- Obligation max wait: 24 hours (86_400_000 ms), auto-timeout after that
- Retry max: 3 per (runId, operationId) pair — policy can lower but not raise
- Parallel tool deny: only the denied tool is blocked, not the entire batch
- Pre-boundary exception = fail-closed deny; post-boundary exception = fail-open diagnostic; error-point exception = terminal abort
- Unknown point ID = immediate block (prevents ad-hoc bypass)
- Descriptor validation failure = pre-boundary deny

### Task 5 Findings (2026-05-14)

- `RuntimeResource.Kind` should stay closed over the governance kinds used by policy routing: tool, skill, mcpSource, worker, credential, session, policy.
- `RuntimeResource.Descriptor` should validate the id shape against both the kind segment and optional source segment so descriptors stay canonical and replayable.
- `ActorDescriptor` and `SessionDescriptor` belong beside `RuntimeResource.Descriptor` as plain serializable Zod contracts; runtime construction stays in upper packages.
- `PolicyPoint` now exposes `Id`, `Contract`, `Registry`, and `TimingAliases` on the schema object, which keeps legacy timing tests and the new point-registry contract aligned.

#### Spec Structure After Task 1
- Total lines: ~520 (was 358)
- New sections added: PolicyPoint Contract Registry, Per-Effect Merge Rules, Obligation Lifecycle, ActorDescriptor, SessionDescriptor, Error Point Semantics, Edge Cases
- 3-tier mapping table replaces flat 14-timing table (flat table still present as legacy reference)

#### Evidence
- TDD assertions: 52 total, all PASS
- Verification file: `.sisyphus/evidence/task-1-spec-completeness.txt`
- `bun run check-types`: PASS (no code changes, spec is docs-only)

## Decisions

## Issues

## Problems

### Task 3 Findings (2026-05-14)

- `Policy.PolicyPoint` now preserves the legacy Zod schema while exposing `Id`, `Contract`, `Registry`, and `TimingAliases` through `Object.assign`.
- The registry uses 20 concrete contracts because `invoke.prepare` and `invoke.result` each fan out to four resource-specific 3-tier points.
- `PolicyPoint.Id` validates the general 3-tier shape, while `PolicyPoint.Registry` is limited to the required initial contracts.
- Package verification passed with `bun test packages/protocol` and `bun run check-types`.

### Task 4 Findings (2026-05-14)

- `Policy.PolicyEffectType` is now the shared discriminator enum for effect allow-lists and the `PolicyEffect` union, keeping point contracts aligned with supported effects.
- `Policy.PolicyDecision`, `Policy.PolicyObligation`, and `Policy.EffectiveDecision` are schemas only; execution and merge behavior remain outside `@openomni/protocol`.
- Protocol tests import both source and generated `dist` artifacts in this workspace, so `bun run --cwd packages/protocol build` was needed before the package test reflected schema updates consistently.

### Task 6 Findings (2026-05-14)
- `policy.evaluated` can stay backward-compatible by adding optional audit context fields instead of changing the core verdict shape.
- `policy.decision.composed` should use the composed verdict set (`allow | deny | pending`), not the legacy agent verdict set.
- Bun test diagnostics in this repo are happier with explicit no-throw assertions than `.toThrow()` / `.toBeDefined()` matchers.

### Task 17 Findings (2026-05-14)
- Descriptor helpers are safest when they funnel through a tiny internal constructor that fills `labels`, `capabilities`, and `effects` before parsing.
- `RuntimeResource.Descriptor` validation needs to stay strict for tool source segments, but worker/credential/session helpers can attach source metadata without forcing the id to mirror that source type.
- The credential helper should keep file provenance in `source.path`, while the session helper can preserve session lineage in labels and owner metadata without changing the canonical `session:{id}` shape.

### Task 7 Findings (2026-05-14)
- `PolicyPoint.MigrationMapping` should be the canonical legacy-timing bridge, while `TimingAliases` can remain as a compatibility alias.
- The legacy resolver belongs in protocol as a type signature only; runtime resolution stays in the policy engine above protocol.
- `invoke.prepare` and `invoke.result` remain the only 1:N migration cases, each fanning out to four 3-tier point IDs.

### Task 2 Findings (2026-05-14)

#### ADR-007 Update
- Added 3-tier point ID scheme to Decision section (4 matches for "3-tier" in final file)
- Added Audit Decision subsection: Bus event integration via `BusEvent.define()` + `BusPersistence`
- Added unified kind model: `kind: "tool"` for all tools, `source.type` for origin subdivision
- Added `ActorDescriptor` and `SessionDescriptor` to PolicyRequest description
- Updated Migration Strategy step 3 to mention 3-tier ID registration with legacy aliases
- Updated Migration Strategy step 4 to mention `source.type` assignment
- Status remains "Proposed" (not changed)

#### Evidence Files
- `.sisyphus/evidence/task-2-adr-3tier.txt`: 4 matches for "3-tier" (>= 2 required)
- `.sisyphus/evidence/task-2-adr-consistency.txt`: Bus/audit, source.type, Status=Proposed all verified
- Note: `.sisyphus/` is gitignored, evidence files are local only

#### Commit
- `fc1c66d docs: update ADR-007 to reflect 3-tier point system`
- 1 file changed, 15 insertions(+), 6 deletions(-)

### Task 16 Findings (2026-05-14)

- `SkillLoader` can attach runtime descriptors without changing `Skill.Definition` serialization by using non-enumerable properties on loaded skill objects.
- Local skills map to `source.project`; global registry skills map to `source.global`; skill layers map into `skill.layer.{layer}` labels.
- Skill-provided MCP tool descriptors use `source.type: "skill-mcp"` plus `skillId`, keeping tool origin attributable to the behavior injection that contributed it.
- Verification passed with `lsp_diagnostics`, `bun test packages/openomni`, and `bun run check-types`.

### Task 15 Findings (2026-05-14)

- Subagent and background delegation now attach `RuntimeResource.Descriptor` objects to `invoke.prepare` policy contexts without changing the public `SubagentRuntime` API.
- Descriptor labels are also mirrored into `toolLabels`, keeping existing permission label checks usable while the richer descriptor context is available to newer policy gates.
- Background launch descriptors are created at `BackgroundManager.launch()` and forwarded through `BackgroundLimitsMiddleware.evaluatePreLaunch()` into the existing launch gate.
- Verification passed with LSP diagnostics on changed files, `bun test packages/openomni`, and `bun run check-types`.

### Task 14 Findings (2026-05-14)

- MCP tool registration now attaches a `RuntimeResource.Descriptor` directly to each `Tool.Spec` returned by `McpClient.listTools()`.
- MCP descriptor ids follow the plan-specific four-segment format: `tool:mcp:{serverId}:{remoteName}`.
- MCP descriptor labels are mirrored onto `Tool.Spec.labels`, so existing label-based policy paths can see `source.mcp` and `mcp.{serverId}` before deeper descriptor enforcement lands.
- Arbitrary remote MCP tools are conservatively classified with `network.write` capability and `external.write` effect until per-tool read/write metadata exists.
- Evidence file: `.sisyphus/evidence/task-14-mcp-descriptor.txt`.

### Task 13 Findings (2026-05-14)
- `Tool.define()` now creates native tool `RuntimeResource.Descriptor` metadata from canonical labels, derived read/write capabilities, destructive effects, risk tier, and source type.
- Worker bootstrap catalog entries carry optional descriptors so `ToolProxyProvider` can preserve policy metadata across the coordinator/worker boundary without changing tool execution behavior.
- `ToolRuntimePolicyMiddleware` prefers descriptor risk when present and falls back to legacy `riskTier` for backward compatibility.
- Verification passed with `bun test packages/openomni` and `bun run check-types`.

### Task 20 Findings (2026-05-14)
- `composeEffects()` lives in `packages/agent` because protocol owns only the PolicyDecision/PolicyEffect schemas; runtime merge behavior stays above the schema layer.
- Policy priority is not part of `Policy.PolicyDecision`, so the composer reads optional runtime `priority` metadata when present and otherwise falls back to deterministic `policyId` ordering.
- Pre-boundary conflicts fail closed as `deny` plus an `audit.annotate` diagnostic; writeback conflicts are treated as post-boundary diagnostics and keep the composed verdict.
- Verification passed with LSP diagnostics, `bun test packages/agent`, and `bun run check-types`.

### Task 11 Findings (2026-05-14)
- Stream helper deny handling now follows the boundary rule: pre-boundary denies fail closed, while post-boundary denies publish diagnostics and preserve the prior flow.
- Exhaustive `Policy.Verdict` switches are useful in stream helpers because unsupported verdicts must be explicit no-ops rather than accidental fallthroughs.
- `writeback.commit` deny handling is fail-closed in the new stream helper regression path, while transform preserves output rewrite behavior.
- Verification note: focused verdict regression and `bun run check-types` pass; full `bun test packages/agent` is blocked by a pre-existing missing module import in `packages/agent/test/core/policy/effect-composition.test.ts`.
- Follow-up verification: after the pre-existing effect-composition source appeared in the worktree, `bun test packages/agent` passed with 375 tests.

### Task 10 Findings (2026-05-14)
- `createToolExecutor` should treat `deny`, `inject`, and `retry` from `invoke.prepare` as pre-boundary blocking verdicts, so the tool function is never called and no Started event is emitted.
- `inject` is only meaningful for message/control-flow boundaries; at `invoke.prepare` it must fail closed with an explicit denial reason.
- `Tool.Result` has no protocol-level metadata field, so retry-after data is attached only on the blocked retry result while keeping normal success results unchanged.
- Verification passed with LSP diagnostics, `bun test packages/agent/test/core/execution/tool-executor-verdicts.test.ts`, and `bun run check-types`; full `bun test packages/agent` is currently blocked by unrelated `stream-helpers-verdicts.test.ts` export failure in the shared worktree.

### Task 8 Findings (2026-05-14)
- `PolicyEngine.dispatch()` now preserves terminal `deny` verdicts with their original `reason` and `policyId`; later policies are not executed after the first terminal verdict.
- `dispatchSystemPrompt()` now treats `deny` and `abort` as terminal errors instead of continuing prompt composition silently.
- Production pre-boundary verdicts with missing metadata fail closed as `agent.policy.metadata` / `policy-metadata-missing`; post-boundary production warning behavior is preserved.
- Verification: changed-file LSP diagnostics and `bun run check-types` passed. `bun test packages/agent` is currently blocked by unrelated pre-existing untracked execution tests (`tool-executor-verdicts`, `stream-helpers-verdicts`).

### Task 12 Findings (2026-05-14)
- Messenger, inbound receive, writeback commit, subagent pre-delegation, and background launch gates now use exhaustive verdict switches so `deny` is terminal and unsupported verdicts fail closed.
- `writeback.commit` remains the only audited call site here that accepts `transform`; all other non-`continue` verdicts block before the boundary side effect.
- Subagent `spawn`, `spawnBackground`, and `send` share one pre-delegation verdict handler, which prevents deny/unsupported verdict drift across child-session entry points.
- Verification passed for changed-file LSP diagnostics, targeted verdict tests, and `bun run check-types`; full `bun test packages/agent` remains blocked by unrelated pre-existing untracked execution tests in the shared worktree.

### Task 25 Findings (2026-05-14)
- Descriptor conformance coverage now exercises every current `RuntimeResource.Kind`, with tool fixtures split across system, MCP, skill-MCP, agent, and server sources.
- Digest assertions should hash canonical descriptor content without the existing `digest` field, so repeated construction stays stable while label/source changes alter the digest.
- Credential descriptor serialization needs an audit redaction pass before persistence/logging; file-backed source paths should serialize as `[REDACTED]` while still validating against `RuntimeResource.Descriptor`.

### Task 18 Findings (2026-05-14)
- `verdictToDecision()` stays pure in `packages/agent` and returns protocol `Policy.PolicyDecision` objects without changing PolicyEngine dispatch yet.
- Legacy unsupported verdicts now share one boundary helper: pre-boundary and error timings deny with an error audit, while post-boundary timings allow with a warning diagnostic.
- Transform adaptation is intentionally narrow: `context.prepare` maps to `prompt.replace`, `invoke.prepare` maps to `tool.rewrite_input`, and all other timings emit the unsupported-transform diagnostic.
- Verification passed with LSP diagnostics and `bun test packages/agent`.

### Task 19 Findings (2026-05-14)
- `PolicyEngine.dispatchV2()` now preserves legacy policy functions while adapting their verdicts through `verdictToDecision()` into canonical `PolicyDecision` objects.
- The v2 dispatch path composes adapted decisions with `composeEffects()` and returns a composed decision under `agent.policy.composed`, leaving legacy `dispatch()` unchanged.
- Effect validation is enforced against `PolicyPoint.Registry` allow-lists after composition; descriptor-aware tool dispatch narrows `invoke.prepare` / `invoke.result` to native or MCP policy points when resource metadata is available.
- Verification passed with changed-file LSP diagnostics, `bun test packages/agent`, and `bun run check-types`.
