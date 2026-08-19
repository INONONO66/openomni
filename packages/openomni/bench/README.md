# Compaction Benchmarks

Two tiers, one question: **what survives compaction?**

| Tier | What it measures | Cost | Where |
| --- | --- | --- | --- |
| Deterministic probes | The *mechanical* guarantees: byte-survival of user text, evidence presence, compression floor. Runs in CI, no LLM. | free | [`test/bench/compaction-probes.test.ts`](../test/bench/compaction-probes.test.ts) |
| Live quality bench | End-to-end *answer quality* over real long conversations, with a real summarizer, a real responder, and a cross-model judge. | LLM calls | [`bench/compaction/`](./compaction/) |

Both drive the **shipped pipeline** — `buildWorkerMiddleware` → the
`run.completion.pre` seam — so the verbatim cut, the anchored merge, render
decoration, and the byte guard are live, not simulated.

## Live quality bench

### Dataset

[LoCoMo-10](https://github.com/snap-research/locomo) (Maharana et al.): 10
two-speaker conversations of 400–700 turns across ~19 timestamped sessions,
with QA pairs annotated with evidence turns. Downloaded on demand to
`bench/compaction/.cache/` (never committed). Session timestamps are injected
as assistant-role header turns — LoCoMo speech uses relative time
("yesterday"), and real agent session logs carry timestamps the same way.
`speaker_a` maps to `user`: their words are the ones the pipeline must
preserve verbatim, which is the invariant under test.

### Strategies compared

| Strategy | What it is |
| --- | --- |
| `full-history` | No compaction. Upper-bound reference. |
| `anchored` | The shipped pipeline, default preserve budget (80k chars): anchored merge (real LLM) + user turns verbatim + render decoration. |
| `anchored-8k` | Same, with the preserve budget tightened to 8k chars — the retention↔compression dial. |
| `uniform-real` | A **real** (not strawman) regenerate-everything baseline: the *same* summarizer LLM compresses the same span with user turns included — the industry-default shape. |

The anchored strategies and the uniform baseline use the **same summarizer
model**, so the comparison isolates the *strategy*, not the model.

### Grading

1. A **responder** answers each sampled QA reading *only* the strategy's
   window ("UNKNOWN" if absent).
2. A normalized string match against the gold answer settles the easy cases;
   everything else goes to a **cross-model judge** (a different, stronger
   model than the responder/summarizer — same-model judging carries
   self-preference bias) grading against the gold answer.
3. Category-5 (adversarial/unanswerable) QA is excluded: it grades refusal
   calibration, not retention.

### Running it

```sh
# Any OpenAI-compatible endpoint (reference numbers: operator token hub)
export OPENAI_BASE_URL=… OPENAI_API_KEY=…
cd packages/openomni
bun run bench/compaction/run.ts                 # 10 convs × 5 QA
bun run bench/compaction/run.ts --convs 2 --qa-per-conv 3   # smoke
# Model roles: BENCH_SUMMARIZER / BENCH_RESPONDER / BENCH_JUDGE
```

### Recorded results

Run of 2026-08-19 — `summarizer=gpt-5-4-mini responder=gpt-5-4 judge=gpt-5-5`
(operator token hub), 10 conversations × 5 QA (n=50, category 5 excluded),
single cut per conversation:

| Strategy | QA accuracy | c1 single-hop | c2 temporal | compression |
| --- | --- | --- | --- | --- |
| `full-history` (ceiling) | **68.0%** | 57.1% | 90.5% | 0% |
| `anchored` (shipped, as-is) | 22.0% | 33.3% | **4.8%** | 45.0% |
| `anchored-dated` (counterfactual) | **42.0%** | 52.4% | 33.3% | 44.0% |
| `anchored-8k` (tight budget) | 18.0% | 19.0% | 0.0% | 72.7% |
| `uniform-real` (industry default) | 40.0% | 47.6% | 28.6% | 75.6% |

(c3 multi-hop n=6 and c4 open-domain n=2 are too small to read; full
per-conversation rows and the failure dump land in
`bench/compaction/.cache/last-run.jsonl` on every run.)

### The finding: temporal grounding does not survive compaction

The headline is not the ranking — it is the **c2 column**. With session
timestamps modeled the way the shipped render treats them (compressible
content), the anchored window answers temporal questions at **4.8%** against
the full-history ceiling of 90.5%: every "when did X happen" becomes
UNKNOWN, because the preserved user text says "yesterday" and nothing in the
window says when "yesterday" was. The counterfactual (`anchored-dated`) is
the SAME pipeline with timestamps riding the verbatim lane: +20pp overall,
c2 ×7 — proving the gap is **date carriage, not the strategy**.

With dates carried, the anchored strategy beats the real uniform baseline on
quality (42.0% vs 40.0%, and 52.4% vs 47.6% on single-hop) while keeping the
guarantees the uniform shape structurally cannot offer (byte-exact user
text, verified by the deterministic tier; the uniform summary paraphrases
user speech and re-summarizes it every epoch). The uniform baseline does
compress harder (75.6% vs 44.0%) — that is the honest trade until the
anchored render carries a dated timeline, tracked as a production gap.

### Reading the numbers honestly

- **Absolute accuracy is capped by the responder**, not the window: LoCoMo's
  temporal reasoning is hard (resolving "yesterday" against session
  timestamps), and every strategy pays the same responder tax — compare
  *between* strategies and against `full-history`, not to 100%.
- The deterministic tier is the invariant check (user text survives
  byte-exact by construction); this tier measures what that invariant *buys*
  in end-task quality, plus what the anchored merge preserves of
  assistant-side content that verbatim mechanics alone cannot.
- Single cut per conversation (the window jumps once from full to compacted);
  production interleaves cuts with turns, which the deterministic tier's
  two-cycle tests cover.
- n=50 QA is a smoke-scale sample: read the large gaps (the c2 collapse, the
  dated counterfactual), not single-digit differences. The summarizer is
  deliberately a small model — the realistic cost posture; a stronger
  summarizer lifts the anchored/uniform pair together, not their ordering.
- The uniform baseline's accuracy comes WITHOUT any integrity guarantee: its
  user "facts" are paraphrases that the deterministic tier scores at ~1%
  byte survival. Accuracy and integrity are different axes; this bench
  measures the first, the CI tier enforces the second.
