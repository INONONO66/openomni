# ADR-013: Built-in Memory plus a Pluggable Engine Port

**Status**: Proposed

## Context

The Resident's value proposition — "knows your goals and context without asking every time" — is mostly a memory problem, and the long-term memory system (Anamnesis) is a separate project that may land late or change shape. core-model.md already commits to "designed to integrate with Anamnesis, but doesn't depend on it"; this ADR makes that commitment concrete.

The reference design is [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent): a small **built-in memory that always works** (two bounded curated stores injected as a frozen snapshot, plus FTS5 session search), with **external memory providers as plugins** (Honcho, Mem0, and others) that augment — never replace — the built-in layer.

This ADR sits inside [ADR-010](./010-agent-os-kernel-model.md)'s frame (built-in notes are pinned RAM pages, the session store is disk, external engines are indexed cold storage) and consumes candidate streams designed in [ADR-011](./011-task-ledger-evidence-gate.md) and [ADR-012](./012-governor-postmortem-engine.md).

## Decision

### Built-in layer (engine-independent, ships first)

- **Two bounded curated stores**, injected into the Resident's system prompt as a **frozen snapshot** at session start: system notes (environment facts, conventions, lessons; ~800-token budget) and the Owner profile (identity, preferences, communication style; ~500-token budget). The memory tool has `add` / `replace` / `remove` and deliberately **no `read`** — content is always already in context. Mid-session writes persist to disk but render only from the next session, preserving the prefix cache (Hermes's frozen-snapshot pattern, adopted wholesale).
- **Hard character budgets are the structural constraint** (kernel-grade per ADR-010 §1): memory cannot bloat context; growth forces curation — replace and remove are first-class, not afterthoughts.
- **Session search** as a separate axis: FTS5 full-text over the existing session store, exposed as an on-demand tool (millisecond queries, zero token cost until used). Episodic recall without any engine and without curation effort.
- Memory writes ride the autonomy tiers: log-and-report by default, an optional write-approval mode gates every write behind the Owner (Hermes `write_approval` ≈ our Tier 2).

### The engine port

`Memory.Engine`, Zod-first, following the `Storage.Adapter` precedent:

```
ingest(candidate)            // consume MemoryCandidates (async, non-blocking, fire-and-forget)
recall(query, scope)         // retrieval for context assembly — scope filter is MANDATORY
profile(actorId, question?)  // dialectic user/actor modeling ("what does the Owner prefer for X?")
feedback(memoryId, outcome)  // recalled memory was useful / wrong — engines learn from outcomes too
```

Transport-agnostic (in-process, HTTP, or MCP — Anamnesis will likely sit behind HTTP/MCP). Zero engines configured = built-in layer only, fully functional. Multiple engines may coexist (one for semantic search, one for user modeling), all fed from the same candidate stream.

### Scope filtering — the OpenOmni-specific addition

Hermes does not need this; we do. Recall results are filtered by executor scope: the Resident recalls across the Owner scope; a Worker recalls only within its task scope — this is how ADR-009 §9's "memory scoped to the relevant task" becomes enforceable. **The scope filter lives on the port (kernel side), not in engine goodwill.**

### The candidate stream already exists by construction

```
MemoryCandidate {
  content
  scope: owner | domain | project | persona | session
  category: preference | rule | lesson | failure | decision | skill
  provenance: { workItemHash?, sessionId, author }
  confidence
}
```

Emitted from three sources designed in earlier ADRs: ADR-011 WorkItem completion (high-value outcomes), ADR-012 Governor triage (preference-shaped corrections — "taste is memory, defects are structure"), and explicit Owner requests. Engines consume the stream; the built-in curated store is maintained by the Resident itself via the memory tool.

### Wiring is existing hooks, not new plumbing

Frozen-snapshot injection at the `on_system_prompt` policy timing; periodic persistence nudges at `post_turn`/idle timings; candidate emission on `work_item.completed` bus events. The memory engine never blocks execution — ingest failures degrade to "candidate stays queued," recall failures degrade to "built-in snapshot only."

## Rationale

- **Why a port instead of building memory in?** Memory engines are an active research area (semantic stores, knowledge graphs, dialectic user models); committing to one implementation now would couple the OS's lifetime to a bet. The port costs one interface and buys replaceability.
- **Why must the built-in layer ship first?** A system whose "knows you" property depends on an external service that doesn't exist yet has no felt value. Bounded curation + session search is the Hermes-proven floor that works on day one.
- **Why frozen snapshot over live reads?** Prefix-cache preservation (cost/latency) and determinism within a session. The staleness window (one session) is an acceptable price.
- **Why mandatory scope filtering at the port?** A worker contacting an external human must not be able to recall the Owner's unrelated private context. Leaving that to engine implementations would put a security invariant in userland.

## Consequences

### Positive

- Anamnesis becomes a plugin, not a dependency — both projects develop independently against one contract.
- Memory hygiene is structural (budgets), not aspirational.
- The candidate stream gives every future engine the same scoped, attributed, reviewable input core-model.md demands.

### Negative

- Two memory surfaces (curated notes vs engine recall) need a clear precedence story when they disagree.
- Frozen snapshots mean mid-session learning isn't visible until the next session.
- FTS5 indexing over messages adds a storage migration.

## Relationship to prior ADRs

- Concretizes core-model.md "Memory Readiness" and ADR-010's memory-hierarchy framing.
- Scope filter enforces ADR-009 §9 worker outbound constraints.
- Candidate sources are ADR-011 (`work_item.completed`) and ADR-012 (preference triage).
