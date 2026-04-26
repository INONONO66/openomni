<!--
PR title must follow conventional commits: type(scope): description
Examples: feat(session): add Bus filter API, fix(llm): handle provider timeout
-->

## Summary

<!-- What does this PR do and why? (1-3 sentences) -->

Fixes #
Relates to #

## Changes

<!-- Key changes as bullet points. -->

-

## Type

- [ ] `feat` — New feature or capability
- [ ] `fix` — Bug fix
- [ ] `refactor` — Code restructuring (no behavior change)
- [ ] `test` — Adding or updating tests
- [ ] `docs` — Documentation only
- [ ] `chore` — Build, CI, tooling, dependencies
- [ ] `perf` — Performance improvement

## Affected Packages

- [ ] `protocol`
- [ ] `session`
- [ ] `llm`
- [ ] `agent`
- [ ] `openomni`
- [ ] `coordinator`
- [ ] `cli`
- [ ] `server`

## Breaking Changes

- [ ] No breaking changes
- [ ] Yes — describe migration path below

<!-- If breaking, explain what consumers need to change: -->

## Checklist

- [ ] `bun run check-types` passes
- [ ] `bun run script/check-deps.ts` clean
- [ ] Tests added/updated for changes
- [ ] No `as any`, `@ts-ignore`, or `@ts-expect-error` added
- [ ] AGENTS.md updated if public API or architecture changed
