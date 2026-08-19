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
("yesterday") and needs them for the `full-history` ceiling to be answerable
at all. Every turn additionally carries its session's recorded time as
`Message.info.time` — the field production messages carry — so the shipped
time-carriage path (#737 fix: per-message `[recorded date]` markers +
date-headed summarizer input) is exercised as-is, not simulated.
`speaker_a` maps to `user`: their words are the ones the pipeline must
preserve verbatim, which is the invariant under test.

### Strategies compared

| Strategy | What it is |
| --- | --- |
| `full-history` | No compaction. Upper-bound reference. |
| `anchored` | The shipped pipeline, default preserve budget (80k chars): anchored merge (real LLM) + user turns verbatim + render decoration. |
| `anchored-8k` | Same, with the preserve budget tightened to 8k chars — the retention↔compression dial. |
| `uniform-real` | A **real** (not strawman) regenerate-everything baseline: the *same* summarizer LLM compresses the same span with user turns included — the industry-default shape. |

(`anchored-dated`, kept for continuity with the 2026-08-19 baseline, is the
old counterfactual: session-timestamp headers riding the user lane. With
per-message time carriage shipped it adds only noise on top of `anchored`.)

The anchored strategies and the uniform baseline use the **same summarizer
model**, so the comparison isolates the *strategy*, not the model. The
2026-08-19 baseline carried a prompt confound (only the uniform prompt
instructed date/fact coverage); the #737 fix resolved it — the shipped
checkpoint template now instructs date anchoring and carries a
Timeline & Facts section, so both sides state the same coverage intent.

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

Run of 2026-08-20 (canonical — after the #737 time-carriage fix) —
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
| `full-history` (ceiling) | 64.0% | 52.4% | **81.0%** | 0% |
| `anchored` (shipped) | **60.0%** | 57.1% | **71.4%** | 27.2% |
| `anchored-dated` (legacy counterfactual) | 50.0% | 47.6% | 52.4% | 25.4% |
| `anchored-8k` (tight budget) | 34.0% | 23.8% | 38.1% | 61.3% |
| `uniform-real` (industry default) | 44.0% | 47.6% | 38.1% | 73.4% |

(c3 n=6 / c4 n=2 are too small to read. Full rows + the incremental failure
dump land in `bench/compaction/.cache/last-run.jsonl`.)

Ablation, same protocol (aggregate / c2): markers + dated summarizer input
alone → 48.0% / 52.4%; + summarizer output cap aligned to production
(6k, was 1500) → 48.0% / 52.4%; + the template's "completeness beats
brevity" rule for Timeline & Facts → **60.0% / 71.4%**. Date carriage does
the heavy lifting on c2; the completeness rule recovers the
speaker-stated past dates ("in 2019") that live outside session time.
Compression is the honest cost: 45.0% → 27.2% at the default budget — the
dial is `preserveUserMessageChars` (`anchored-8k` still compresses 61.3%).

#### Baseline of 2026-08-19 (before the fix — kept for the record)

| Strategy | sample agg. | c1 (n=21) | c2 (n=21) | compression |
| --- | --- | --- | --- | --- |
| `full-history` (ceiling) | 64.0% | 47.6% | 85.7% | 0% |
| `anchored` (as-was) | 24.0% | 38.1% | **4.8%** | 45.0% |
| `anchored-dated` (counterfactual) | 36.0% | 38.1% | 28.6% | 43.6% |
| `anchored-8k` | 16.0% | 14.3% | 0.0% | 72.7% |
| `uniform-real` | 48.0% | 52.4% | 42.9% | 76.4% |

Run-to-run judge variance on this sample is ±1–2 items (the ceiling itself
moved 60.0–64.0% across three otherwise-identical runs); the fix's +18pp
aggregate and +66.6pp c2 are far outside that band.

### Finding 1: temporal grounding did not survive compaction — found, fixed, re-measured (#737)

The 2026-08-19 baseline's **c2 column**: the then-shipped anchored window
answered temporal questions at **4.8%** against an 85.7% ceiling — every
"when did X happen" became UNKNOWN, because preserved user text said
"yesterday" and nothing in the window said when that was (production then
carried `Message.info.time` but rendered it nowhere). The dated
counterfactual proved the gap was **date carriage, not the strategy**.

The #737 fix ships time carriage end-to-end: every cut stamps each
preserved user message with a `[recorded YYYY-MM-DD]` marker regenerated
from its recorded time (markers never enter the replacement record — the
record carries structured `time` per kept entry, and hydration threads it
back so a resumed cut re-derives dates from the record, not from resume
time); the summarizer input is date-headed per message; and the checkpoint
template gains a date-anchored Timeline & Facts section. Re-measured on the
same protocol: c2 4.8% → **71.4%** (ceiling 81.0%), aggregate 24.0% →
**60.0%**.

### Finding 2: the 2026-08-19 uniform lead was the confound, and it inverted

The 2026-08-19 baseline recorded the uniform baseline LEADING sampled QA
accuracy (48.0% vs 24.0%) and named a prompt confound: the uniform prompt
instructed date/fact coverage while the shipped checkpoint template was
task-oriented with no date instruction and no home for narrative facts.
The #737 fix removed exactly that confound (date anchoring + Timeline &
Facts with completeness-over-brevity) — and the lead inverted: anchored
**60.0%** vs uniform 44.0%, with byte-exact user text on top (the uniform
window's user "facts" remain paraphrases the CI tier scores at ~1% byte
survival). The two axes stayed separate the whole way: integrity never came
from accuracy, and the accuracy deficit turned out to be prompt- and
carriage-shaped, not inherent to the anchored design.

Honest residuals: anchored pays ~18pp of compression for the retention
(27.2% vs uniform's 73.4% on this run — the preserve budget is the dial);
and uniform's own numbers moved 42.0–48.0% across reruns, so read the gap
(+16pp), not the decimals.

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
- n=50 QA is a smoke-scale sample: read the large gaps (the baseline's c2
  collapse, the fix's recovery), not single-digit differences. The
  summarizer is deliberately a small model — the realistic cost posture.
- The uniform baseline's accuracy comes WITHOUT any integrity guarantee: its
  user "facts" are paraphrases that the deterministic tier scores at ~1%
  byte survival. Accuracy and integrity are different axes; this bench
  measures the first, the CI tier enforces the second.
