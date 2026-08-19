import { buildConversation, loadDataset, type LocomoQA } from "./dataset";
import { grade, type GradedQA } from "./evaluate";
import { mapLimit, requireEnv, usage } from "./llm";
import { anchored, fullHistory, uniformReal, type BuiltWindow } from "./strategies";

/**
 * Compaction live-quality bench over LoCoMo-10 (see bench/README.md for
 * methodology and recorded results).
 *
 *   bun run bench/compaction/run.ts [--qa-per-conv 5] [--convs 10]
 *
 * Requires OPENAI_BASE_URL / OPENAI_API_KEY (any OpenAI-compatible endpoint;
 * the reference numbers were produced through the operator's token hub).
 * Model roles are env-overridable:
 *   BENCH_SUMMARIZER (default gpt-5-4-mini) — the anchored merge AND the
 *     uniform baseline use the same summarizer, so the comparison isolates
 *     the STRATEGY, not the model.
 *   BENCH_RESPONDER  (default gpt-5-4)
 *   BENCH_JUDGE      (default gpt-5-5) — cross-model judging on purpose.
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length - 1; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key?.startsWith("--") && value !== undefined) args.set(key.slice(2), value);
}
const QA_PER_CONV = Number(args.get("qa-per-conv") ?? 5);
const CONVS = Number(args.get("convs") ?? 10);

const MODELS = {
  summarizer: process.env.BENCH_SUMMARIZER ?? "gpt-5-4-mini",
  responder: process.env.BENCH_RESPONDER ?? "gpt-5-4",
  judge: process.env.BENCH_JUDGE ?? "gpt-5-5",
};

requireEnv();
const data = (await loadDataset()).slice(0, CONVS);

/** Category 5 is adversarial ("not answerable") — excluded: it grades the
 * responder's refusal calibration, not the window's retention. */
function sampleQA(qa: readonly LocomoQA[]): LocomoQA[] {
  return qa.filter((q) => q.category !== 5 && q.answer !== undefined).slice(0, QA_PER_CONV);
}

interface StrategyResult {
  name: string;
  window: BuiltWindow;
  graded: GradedQA[];
}

const rows: Array<{
  sampleId: string;
  turns: number;
  fullChars: number;
  strategies: StrategyResult[];
}> = [];

for (const conv of data) {
  const sessionID = `bench-${conv.sample_id}`;
  const built = buildConversation(conv, sessionID);
  const builtDated = buildConversation(conv, sessionID, { headerRole: "user" });
  const qa = sampleQA(built.qa);
  if (qa.length === 0) continue;

  const full = fullHistory(built.messages);
  console.error(
    `[${conv.sample_id}] turns=${built.messages.length} qa=${qa.length} — building windows…`,
  );
  const windows: Array<{ name: string; window: BuiltWindow }> = [
    { name: "full-history", window: full },
    {
      name: "anchored",
      window: await anchored(built.messages, sessionID, MODELS.summarizer),
    },
    {
      // Counterfactual: identical pipeline, timestamps in the verbatim lane.
      name: "anchored-dated",
      window: await anchored(builtDated.messages, sessionID, MODELS.summarizer),
    },
    {
      name: "anchored-8k",
      window: await anchored(built.messages, sessionID, MODELS.summarizer, 8_000),
    },
    { name: "uniform-real", window: await uniformReal(built.messages, MODELS.summarizer) },
  ];

  const strategies: StrategyResult[] = [];
  for (const { name, window } of windows) {
    console.error(`[${conv.sample_id}] grading ${name} (${window.chars} chars)…`);
    const graded = await mapLimit(qa, 4, (q) => grade(MODELS, window.texts, q));
    strategies.push({ name, window, graded });
  }
  rows.push({
    sampleId: conv.sample_id,
    turns: built.messages.length,
    fullChars: full.chars,
    strategies,
  });
}

const names = rows[0]?.strategies.map((s) => s.name) ?? [];
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log(
  `\nmodels: summarizer=${MODELS.summarizer} responder=${MODELS.responder} judge=${MODELS.judge}`,
);
console.log(`sample: ${rows.length} conversations × ${QA_PER_CONV} QA (category 5 excluded)\n`);
console.log(`conv | turns | full-chars | ${names.map((n) => `${n}: acc chars`).join(" | ")}`);
for (const row of rows) {
  const cells = row.strategies.map((s) => {
    const acc = s.graded.filter((g) => g.correct).length / s.graded.length;
    return `${pct(acc)} ${s.window.chars}`;
  });
  console.log(`${row.sampleId} | ${row.turns} | ${row.fullChars} | ${cells.join(" | ")}`);
}

console.log("\nAGGREGATE");
for (const name of names) {
  const all = rows.flatMap((r) => {
    const s = r.strategies.find((x) => x.name === name);
    return s ? s.graded : [];
  });
  const acc = all.filter((g) => g.correct).length / all.length;
  const byJudge = all.filter((g) => g.settledBy === "judge").length;
  const compression =
    1 -
    rows.reduce((sum, r) => {
      const s = r.strategies.find((x) => x.name === name);
      return sum + (s ? s.window.chars / r.fullChars : 0);
    }, 0) /
      rows.length;
  console.log(
    `${name.padEnd(13)} QA accuracy ${pct(acc)} (${all.length} QA, ${byJudge} judge-settled) | compression ${pct(compression)}`,
  );
}

console.log("\nBY CATEGORY (1 single-hop, 2 temporal, 3 multi-hop, 4 open-domain)");
for (const name of names) {
  const all = rows.flatMap((r) => r.strategies.find((x) => x.name === name)?.graded ?? []);
  const cats = [1, 2, 3, 4].map((c) => {
    const inCat = all.filter((g) => g.qa.category === c);
    if (inCat.length === 0) return `c${c}: -`;
    return `c${c}: ${pct(inCat.filter((g) => g.correct).length / inCat.length)} (${inCat.length})`;
  });
  console.log(`${name.padEnd(13)} ${cats.join("  ")}`);
}

// Failure dump for diagnosis (gitignored cache dir).
const dump = rows.flatMap((r) =>
  r.strategies.flatMap((s) =>
    s.graded.map((g) => ({
      conv: r.sampleId,
      strategy: s.name,
      category: g.qa.category,
      question: g.qa.question,
      gold: g.qa.answer,
      response: g.response,
      correct: g.correct,
      settledBy: g.settledBy,
    })),
  ),
);
await Bun.write(
  new URL("./.cache/last-run.jsonl", import.meta.url).pathname,
  dump.map((d) => JSON.stringify(d)).join("\n"),
);

console.log("\nLLM usage:");
for (const [model, u] of Object.entries(usage)) {
  console.log(`  ${model}: ${u.calls} calls, in ${u.inputTokens} tok, out ${u.outputTokens} tok`);
}
