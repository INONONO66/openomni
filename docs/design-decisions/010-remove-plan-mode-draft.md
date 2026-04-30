# ADR-010: Remove Plan Mode (DRAFT)

**Status**: Draft
**Date**: 2026-05-01

## Context

Plan mode (`/plan` prefix → `PlanAgent`) was added as an early experiment for structured multi-step execution via LLM-generated plans. It has not been actively developed since initial implementation and carries significant maintenance cost relative to its value.

The persona workforce direction (ADR-005, `docs/persona-workforce.md`) supersedes plan mode's original purpose — the Main Persona + SubagentRuntime + self-loop sessions provide a more robust orchestration model.

## Decision

Remove plan mode entirely from the codebase.

## Scope of Removal

### Protocol layer (`packages/protocol`)
- `src/plan/index.ts` — `Plan`, `PlanStep`, `PlanResult` schemas
- Remove `plan` from protocol barrel export

### Openomni layer (`packages/openomni`)
- `src/plan/` directory (4 files):
  - `plan-agent.ts` — `PlanAgent.create()`
  - `run-plan.ts` — `runPlan()`, plan validation, markdown/JSON parsing
  - `plan-tools.ts` — `plan_*` tool definitions
  - `index.ts` — plan barrel export
- `src/ingress/engine.ts` — remove `"plan"` case from mode switch
- `src/ingress/handlers.ts` — remove `handlePlan`
- `src/ingress/session-bridge.ts` — remove plan-related session bridge logic
- `src/execution-runtime/tool/plan/` — plan tool provider + tests

### Session layer (`packages/session`)
- `Storage.PlanSubAdapter` — plan storage interface and implementations

### Tests
- `test/plan/run-plan.test.ts`
- `test/plan/plan-agent-create.test.ts`
- `src/execution-runtime/tool/plan/provider.test.ts`

### Documentation
- `AGENTS.md` — remove plan mode references from mode table and WHERE TO LOOK
- `README.md` — remove plan mode from ingress mode table
- `docs/persona-runtime-roadmap.md` — update if referencing plan mode

### Ingress mode
- Remove `"plan"` from `IngressMode` discriminated union
- `IngressEngine` switch becomes `"direct"` only (with default throw already in place)

## Migration

No external consumers. Plan mode was never exposed as a public API — it was triggered internally via `/plan` prefix in ingress. Removal is purely internal.

## Risks

- **Low**: No production users depend on plan mode
- **Medium**: Some plan-related test infrastructure is interleaved with ingress tests — careful deletion needed

## Checklist (for implementation PR)

- [ ] Delete `packages/protocol/src/plan/`
- [ ] Delete `packages/openomni/src/plan/`
- [ ] Delete `packages/openomni/src/execution-runtime/tool/plan/`
- [ ] Remove `"plan"` case from `IngressEngine` mode switch
- [ ] Remove `handlePlan` from ingress handlers
- [ ] Remove `Storage.PlanSubAdapter`
- [ ] Delete plan-related test files
- [ ] Update `AGENTS.md`, `README.md` mode tables
- [ ] `bun run check-types` passes
- [ ] `bun run test` passes
- [ ] `bunx biome check .` clean
