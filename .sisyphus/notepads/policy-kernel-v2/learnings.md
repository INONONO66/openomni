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

### Task 6 Findings (2026-05-14)
- `policy.evaluated` can stay backward-compatible by adding optional audit context fields instead of changing the core verdict shape.
- `policy.decision.composed` should use the composed verdict set (`allow | deny | pending`), not the legacy agent verdict set.
- Bun test diagnostics in this repo are happier with explicit no-throw assertions than `.toThrow()` / `.toBeDefined()` matchers.

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
