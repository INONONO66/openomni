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
("yesterday") and needs them; note that production currently renders NO
timestamps at all (see Finding 1's fidelity note), so these headers are a
best-case variant of production.
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
model**, so the comparison isolates the *strategy*, not the model — with
one residual prompt confound, named in Finding 2's caveats.

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

Run of 2026-08-19 (grader-corrected rerun — canonical) —
`summarizer=gpt-5-4-mini responder=gpt-5-4 judge=gpt-5-5` (operator token
hub), 10 conversations × 5 QA, single cut per conversation.

**Sampling disclosure:** QA are the FIRST 5 eligible per conversation
(dataset order, category 5 excluded), NOT random. The sample is
category-skewed vs the eligible population: sampled c1 42% / c2 42% /
c3 12% / c4 4% against population c1 18% / c2 21% / c3 6% / c4 55%. The
per-category columns are the primary reading; the aggregate column is a
composition-biased sample statistic, kept only for within-run comparison.

| Strategy | sample agg. | c1 single-hop (n=21) | c2 temporal (n=21) | compression |
| --- | --- | --- | --- | --- |
| `full-history` (ceiling) | 64.0% | 47.6% | **85.7%** | 0% |
| `anchored` (shipped, as-is) | 24.0% | 38.1% | **4.8%** | 45.0% |
| `anchored-dated` (counterfactual) | 36.0% | 38.1% | 28.6% | 43.6% |
| `anchored-8k` (tight budget) | 16.0% | 14.3% | 0.0% | 72.7% |
| `uniform-real` (industry default) | 48.0% | 52.4% | 42.9% | 76.4% |

(c3 n=6 / c4 n=2 are too small to read. Full rows + the incremental failure
dump land in `bench/compaction/.cache/last-run.jsonl`.)

### Finding 1: temporal grounding does not survive compaction (#737)

The **c2 column**: the shipped anchored window answers temporal questions at
**4.8%** against an 85.7% full-history ceiling — every "when did X happen"
becomes UNKNOWN, because preserved user text says "yesterday" and nothing in
the window says when that was. The counterfactual (`anchored-dated`, the
SAME pipeline with session timestamps riding the verbatim lane) recovers
c2 ×6 and +12pp aggregate at identical compression: the gap is **date
carriage, not the strategy**. Replicated across both recorded runs.

Production fidelity note (stated precisely): production renders NO
timestamps at all — `Message.info.time` exists but nothing carries it into
the model view — so production is *at or below* the benched condition, and
the finding holds a fortiori. The bench's assistant-role headers are a
best-case variant of what production does today.

### Finding 2: on sampled QA accuracy, the uniform baseline currently leads

On this sample the real regenerate-uniform baseline outscores the shipped
anchored strategy (48.0% vs 24.0%; vs 36.0% dated), at higher compression.
Two caveats, then the honest reading:

- The anchored-vs-uniform comparison carries a **prompt confound**: the
  uniform prompt explicitly instructs date/fact coverage, while the shipped
  senpi-shaped checkpoint template (Goal/Progress/Next Steps) is
  task-oriented with no date instruction and no natural home for narrative
  facts. Only the `anchored` / `anchored-dated` pair is causally clean.
- Accuracy and integrity are different axes: the uniform window's user
  "facts" are paraphrases (the CI tier measures ~1% byte survival), it
  re-summarizes user text every epoch (drift compounds), and it can offer
  none of the guarantees the anchored pipeline enforces (byte guard,
  anchored merge, recall pointers, replacement records).

Reading: for narrative-recall workloads, today's anchored strategy pays its
integrity guarantees with QA accuracy, and the deficit is concentrated in
(a) date carriage (#737) and (b) the checkpoint template's weakness at
narrative facts — both actionable, both now measurable by this bench.

### Harness notes

- `speculate: false` in the bench (production speculates by default; same
  template, different call timing — no window-content difference for a
  single forced cut) and the trigger is forced via a synthetic
  measured-tokens value through the REAL threshold gate.
- Grader: normalized containment settles easy matches (short golds require
  word-boundary equality — containment hazards like "no" ⊂ "unknown" are
  real and were fixed after review); everything else goes to the
  cross-model judge. Aggregate numbers are judge-limited: treat single-item
  (2pp) differences as noise.

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
  deliberately a small model — the realistic cost posture.
- The uniform baseline's accuracy comes WITHOUT any integrity guarantee: its
  user "facts" are paraphrases that the deterministic tier scores at ~1%
  byte survival. Accuracy and integrity are different axes; this bench
  measures the first, the CI tier enforces the second.
