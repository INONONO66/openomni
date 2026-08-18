# Compaction & Context Window Design

Last verified against `origin/main`: 2026-08-18. Design target document; [`docs/implementation-status.md`](implementation-status.md) alone says what is wired. Supersedes the two open Phase 3 rows in [`docs/agent-core-rewrite.md`](agent-core-rewrite.md) ("cut planning, incremental summarization" and "speculative overlap (D8)") — those rows now resolve here.

## Outcome

The context window stops being managed state and becomes an **issued view over the ledger**: compaction never destroys information (everything elided or cut remains addressable in the ledger), user messages survive every compression byte-identical, summarization maintains one persistent structured anchor instead of regenerating prose, and the expensive summary work runs speculatively in the background so the apply seam almost never waits on a model call. Resume becomes projection recomputation, dissolving the class of defects behind [#702](https://github.com/INONONO66/openomni/issues/702).

**Supersession note (2026-08-19 Owner ruling):** summarization is enabled by default in production — both hosts wire `createAnchorCompletion` (one-shot, tool-less, run's own model/auth/providerOptions/signal). Supersedes #649's elision-only default; a seam-merge summarizer failure degrades to a recorded skip, never a run kill.

## Principles

1. **The ledger is the record; the window is a consumable projection.** Nothing is deleted by compaction — the window drops content only by replacing it with something addressable (a recall pointer, a compaction record, an anchor version). Every shipping-at-scale runtime surveyed (opencode, pi, Amp, Letta, Zep, Mem0) has converged on this split; none treats the context window as the system of record.
2. **Asymmetric lossiness: user tokens are lossless, model tokens are compressible.** Assistant narration and tool output are regenerable derivatives; user utterances are irreplaceable intent. Summarization measurably destroys them: constraint questions answer at 19.0% exact-match from summaries vs 93.0% from verbatim artifacts (arXiv:2601.00821 v1; the v4 revision generalizes — verbatim chunks beat lossy artifact extraction by 15.9–22.0pp under an identical pipeline). So the summarizer never receives user messages as input. User text survives compaction verbatim (recent, budgeted) or as verbatim quotation inside the anchor **render** — quotations are injected deterministically at render time from ledger originals, exactly like the L6 artifact table, never produced by the summarizer. A guard checks byte-identity after every apply, covering both window user messages and anchor quotations.
3. **Structure forces preservation.** Summarizer output volume is largely insensitive to prompt instructions and fluctuates run-to-run (arXiv:2605.23296), so what survives cannot be steered by asking. The anchor is a sectioned checklist the summarizer must populate or explicitly leave empty, and it is **updated by incremental merge, never regenerated** — regeneration is the recursive-summary drift that OpenAI measured degrading Codex accuracy and that Factory's evaluation (3.70 vs 3.44/3.35 vs Anthropic/OpenAI regenerating approaches) beat with exactly this anchored-merge shape.
4. **One deterministic apply seam** (D8, unchanged): background work only *computes*; history is rewritten only at `run.completion.pre` via `run.replace_messages`, recorded as an effect. The freshness guard (below) is what makes speculation safe under this rule.
5. **Deterministic facts are not the summarizer's job.** File/artifact state derives mechanically from the ledger (record-before-act already captures tool effects). The one published probe-based compaction evaluation (Factory's, 36k production messages) scores all three tested methods 2.19–2.45/5 on artifact tracking when it is delegated to summarization — Factory's own explicit file sections included; senpi routes around it the same way (deterministic `extractFileOpsFromMessage`, carried across compaction generations).

## Prior art adopted

| Source | What we take | Where it lands |
| --- | --- | --- |
| pss-runtime `speculative-compaction.ts` | Two-phase prepare (65%) / promote (80%) with **no model call at promote** when the candidate is fresh (stale/absent candidate, or an overflow needing a broader range, falls back to a synchronous summarize); freshness guard = prefix snapshot equality; fire-and-forget single-flight scheduling at turn settlement; blocking path only on overflow | L4 |
| pss-runtime `snapshot.ts` / `loop-overflow.ts` | Immutable history + overlay `ThreadCompactionRecord {startSeq, endSeqExclusive, summary}`; window as projection; provider context-overflow classification → blocking compact → one retry | L3, L5 |
| senpi `harness/compaction/compaction.ts` | Anchored iterative summarization: `UPDATE` prompt receives `<previous-summary>` and merges only the newly cut span (PRESERVE + ADD + move In-Progress→Done); sectioned template (Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context); cut-point discipline (never split tool pairs; split-turn prefix summarized separately); summary calls cache-isolated (`cacheRetention: "none"`, fresh session) | L2 (template as openomni config) |
| senpi `CompactionDetails` | Deterministic file-ops extraction carried across compaction generations — but ours derives from the ledger, not from message scans | L6 |
| Codex CLI (production) | User messages preserved verbatim through compaction (budgeted, most recent first); stale summary messages excluded from verbatim user-message preservation | L2 |
| Factory.ai evaluation | Probe-based measurement (recall / artifact / continuation / decision probes, blind judge), **tokens-per-task** as the target metric rather than compression ratio | L7 |

Headline numbers from the research corpus (all citations inline and publicly verifiable): curated context 91.6% vs full-history 71.0% task completion at 37% of tokens (arXiv:2606.10209); mid-context task collapse up to 88pp with tail re-assertion restoring to ±4pp (arXiv:2605.23170); append-only ID-addressable logs 99.40% vs 88.12% best-performing baseline in that evaluation (arXiv:2607.25066).

## Data model

```
Ledger (durable, append-only — session store + bus records):
  messages[]              full history, user text byte-exact
  compactionRecords[]     { cut range boundaries (message ids), anchorVersion }
  anchor                  versioned structured summary document

Run memory (volatile):
  window[]                the projection the model sees
  candidate               { range, nextAnchor, prefixFingerprint } | none
```

## Lifecycle

**Turn settlement (`run.turn.post` timing, per-run policy-factory state):**
- measured ≥ prepare ratio (default 0.65 of window) → fire `prepare()` in the background: single-flight per run, failure = no candidate reported via `operational.warn` with a consecutive-failure cap that disables speculation for the run (never a run error). No AbortSignal linkage — dispatch contexts are structured-clone frozen, so per-run candidate state simply dies with the run's engine.
- `prepare()` input = the would-be cut span **minus user messages minus prior summary renders**; the summarizer merges it into the previous anchor (senpi UPDATE contract). Output candidate carries a prefix fingerprint of the history it summarized.

**Apply seam (`run.completion.pre`, threshold ≥ 0.8 or window yield — existing wiring unchanged):**
1. Elision first (existing `reduce.ts`), markers now carrying recall pointers: `[output elided: N chars — recall: <callID>]`. Enough reclaim → done.
2. Promote: candidate present and prefix fingerprint still matches → adopt `nextAnchor` with **zero model calls**; stale/absent candidate → synchronous merge (the only blocking summary path left).
3. Rebuild window = `[anchor render (anchor body + ledger-derived artifact table + current-goal recitation), recent user messages verbatim within budget, protected tail]`.
4. Record: `run.replace_messages` effect (existing) + CompactionRecord appended to the ledger (new). Guard: every user message in the rebuilt window is byte-identical to its ledger original — violation is a hard finding, not a warning.

**Provider overflow (new):** classify context-length errors (llm package) and **re-enter the existing seam**, exactly as #651's yield does — the overflow handler never rewrites history itself; it dispatches `run.completion.pre` blocking (promote if possible), then retries the call once. Overflow is a third trigger into the one apply seam, not a second apply moment; a second overflow ends the run honestly. (pss applies mid-loop here — we deliberately diverge to keep Principle 4 intact.)

**Resume:** load messages + compactionRecords + anchor from the ledger, recompute the projection with the same rebuild function. No window state is carried; #702's class disappears.

## Delta map

| Leaf | Scope | Packages | Depends on |
| --- | --- | --- | --- |
| L1 | Elision marker gains recall pointer (`reduce.ts`); the `recall.output` tool reads the original from the session store (scoped to fact-recorded turns — resident-direct and child streams persist no tool parts and refuse loudly) | agent, openomni | — |
| L2 | `onSummarize(cutSpan, previousAnchor?)` contract; prior-summary and user-message exclusion from summarizer input; `[anchor, verbatim users, tail]` rebuild; senpi-template summarizer injected as openomni config (domain strings stay out of core) | agent, openomni | — |
| L3 | Replacement record rides on the anchor message's part metadata as ordered kept CONTENT (role/text — ids do not survive the hydration seam, which flattens to strings and re-mints ids); the openomni seam wrapper persists the anchor record-before-act with visible fail-open, and `SessionBridge.buildDirectMessages` (the single seam both hydration readers share) consumes it (#702). Shipped WITHOUT protocol schema growth — the anticipated snapshot surface was routed around by the metadata disposition, noted here explicitly as the sign-off record | agent, session, openomni | L2 (anchor) |
| L4 | `compaction/speculate.ts`: prepare/promote as per-run policy state (factory registration at `run.turn.post` + the existing seam) — single-flight fire-and-forget prepare at the prepare ratio (default 0.65); freshness = the candidate's message-id span is still a live prefix (tolerates later turns and elision, invalidated by any replacement); promoted/discarded reported as reasonCodes at the seam. No AbortSignal linkage — dispatch contexts are structured-clone frozen, so per-run candidate state simply dies with the run's engine and the prepare's duration is bounded by the host completion fn | agent | L2 |
| L5 | Context-overflow error classification + blocking compact + one retry | llm, agent | — |
| L6 | Anchor render: ledger-derived artifact table + goal recitation | openomni | L2 |
| L7 | Byte guard enforced at the wrapper — tag-qualified multiset byte-identity of user text against the SEAM'S INPUT (a core-pipeline integrity check: at most one well-shaped anchor earns exemption, injected texts must match injected inputs; anchor quotations stay verbatim BY CONSTRUCTION via L6's deterministic quoting, not re-checked here), violation refuses the effect visibly + deterministic seeded probe bench (byte-presence probes with a compaction floor; the uniform side is an illustrative hardcoded baseline, the anchored side runs the real seam; blind LLM judge stays pluggable/manual) | openomni (guard + bench) | L2–L6 |

What already exists stays: trigger measurement (#644), elision mechanics (#645), default-on registration with honest skips (#649), window yield (#651), the bracket (#701), the seam adapter (`compaction/policy.ts`), and the boundary invariant. The freeform one-shot `onSummarize` path is replaced by L2 **before it acquires production users** — it is opt-in and default-off today, so no migration exists.

## Risks and their guards

- **Speculation waste**: a prepared candidate discarded by the freshness guard is a paid model call. Bounded by: anchor-merge inputs are small (only the new span), cache-isolated calls, and a recorded discard rate — if live data shows waste dominating, the prepare ratio is config.
- **Anchor poisoning**: a bad merge persists across generations. Countered by the structural template (sections can be wrong but not silently absent), the byte-guarded user quotes, and L7 probes run at merge points in the bench (Slipstream-style validation is a candidate follow-up, not in scope).
- **Background work in the core loop** (first async side-work in `turn.ts`): pss's shape is the defense — the runtime owns state and commits, the policy/candidate only returns data, application stays at the one seam, and the AbortSignal linkage is run-scoped per the #692 lesson.
- **Cache economics**: append-only within a phase; history rewrites happen only at the seam (already true) and the anchor render is a stable prefix block. Summary calls never write cache (senpi rule).
