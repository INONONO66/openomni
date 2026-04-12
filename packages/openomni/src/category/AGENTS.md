# Category Module

## Purpose

This module maps task intent categories to routing hints for agents, tools, and prompt shaping.
It is intentionally declarative so Team Mode can enrich dispatch without hard-coding model names.

## Built-in Categories

| Name | Description | When to use |
| --- | --- | --- |
| quick | Fast path for trivial work | Small fixes, narrow edits, low-risk tasks |
| deep | Research plus implementation | Multi-file changes, tracing dependencies, autonomous execution |
| visual-engineering | Visual or UX-sensitive work | Browser validation, UI polish, layout debugging |
| ultrabrain | Highest ambiguity and reasoning load | Planning-heavy work, synthesis, difficult tradeoffs |
| writing | Communication-first tasks | Docs, specs, summaries, polished prose |
| unspecified-high | Safe complex fallback | Unknown requests that probably need deeper handling |
| unspecified-low | Safe lightweight fallback | Unknown requests that should begin with minimal action |

## Resolution Algorithm

`resolveCategory(name, custom?)` checks three sources in order:

1. Custom categories passed by the caller
2. Built-in categories exported by this module
3. Fallback category (`unspecified-low`) when no exact match exists

The resolver returns both the selected config and the source that supplied it.

## Extension Points

- Add user or workspace categories by passing `custom` entries to `resolveCategory`
- Keep custom entries shape-compatible with `CategoryConfig`
- Override a built-in by reusing the same `name` in the custom array
- Prefer data-first additions in `builtin-categories.ts` over branching logic

## Relationship to Team Mode

This module does not perform dispatch on its own.
T13 uses the resolved category to enrich teammate selection, tool hints, and prompt context.
That keeps `src/category/` dependency-free from `team/` and `plan/` while still acting as shared routing input.
