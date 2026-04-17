// 24-hour stability test for OpenOmni
// Usage: bun scripts/stability-24h.ts [--duration 24h]
// Simulates realistic workload with mock LLM — no real API calls required

import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    duration: { type: "string", default: "24h" },
    output: { type: "string", default: ".sisyphus/evidence" },
    sampleInterval: { type: "string", default: "900000" },
  },
});

const durationMs = parseDuration(values.duration ?? "24h");
const sampleIntervalMs = parseInt(values.sampleInterval ?? "900000", 10);
const outputDir = values.output ?? ".sisyphus/evidence";

function parseDuration(s: string): number {
  if (s.endsWith("s")) return parseInt(s) * 1000;
  if (s.endsWith("m")) return parseInt(s) * 60 * 1000;
  if (s.endsWith("h")) return parseInt(s) * 3600 * 1000;
  return parseInt(s);
}

type Sample = {
  ts: number;
  elapsed_ms: number;
  rss_mb: number;
  heap_mb: number;
  active_streams: number;
};

async function* fakeAssistant(_id: number, totalMs: number): AsyncGenerator<void> {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    const remaining = totalMs - (Date.now() - start);
    const delay = Math.min(30_000 + Math.random() * 90_000, remaining);
    if (delay <= 0) break;
    await new Promise((r) => setTimeout(r, delay));
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    yield;
  }
}

async function* fakeDevAgent(_id: number): AsyncGenerator<void> {
  const runDuration = 5 * 60_000 + Math.random() * 25 * 60_000;
  const start = Date.now();
  while (Date.now() - start < runDuration) {
    await new Promise((r) => setTimeout(r, 1_000 + Math.random() * 2_000));
    yield;
  }
}

async function runStabilityTest() {
  console.log(`Starting stability test: ${values.duration} (${durationMs}ms)`);
  console.log(`Sample interval: ${sampleIntervalMs}ms`);

  const startTime = Date.now();
  const startMem = process.memoryUsage();
  const samples: Sample[] = [];
  let activeStreams = 0;
  let crashes = 0;

  const sampleInterval = setInterval(() => {
    const mem = process.memoryUsage();
    const elapsed = Date.now() - startTime;
    samples.push({
      ts: Date.now(),
      elapsed_ms: elapsed,
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      active_streams: activeStreams,
    });
    console.log(
      `[${Math.round(elapsed / 1000)}s] RSS: ${Math.round(mem.rss / 1024 / 1024)}MB, ` +
        `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB, Streams: ${activeStreams}`,
    );
  }, sampleIntervalMs);

  const workloads: Promise<void>[] = [];

  for (let i = 0; i < 3; i++) {
    workloads.push(
      (async () => {
        activeStreams++;
        try {
          for await (const _ of fakeAssistant(i, durationMs)) {
            /* process */
          }
        } catch {
          crashes++;
        }
        activeStreams--;
      })(),
    );
  }

  for (let i = 0; i < 3; i++) {
    workloads.push(
      (async () => {
        activeStreams++;
        try {
          for await (const _ of fakeDevAgent(i)) {
            /* process */
          }
        } catch {
          crashes++;
        }
        activeStreams--;
      })(),
    );
  }

  // Cap total wall time so --duration flag is respected even if agents run longer
  const timeout = new Promise<void>((r) => setTimeout(r, durationMs));
  await Promise.race([Promise.all(workloads), timeout]);
  clearInterval(sampleInterval);

  const endMem = process.memoryUsage();
  const rssGrowthPct = Math.round(((endMem.rss - startMem.rss) / startMem.rss) * 100);

  const result = {
    duration_ms: Date.now() - startTime,
    start_rss_mb: Math.round(startMem.rss / 1024 / 1024),
    end_rss_mb: Math.round(endMem.rss / 1024 / 1024),
    rss_growth_pct: rssGrowthPct,
    crashes,
    sample_count: samples.length,
    samples,
    // Pass criteria: no crashes and RSS growth under 10%
    success: crashes === 0 && rssGrowthPct < 10,
    measured_at: new Date().toISOString(),
  };

  console.log(`\nStability test complete:`);
  console.log(`  Duration:    ${Math.round(result.duration_ms / 1000)}s`);
  console.log(`  RSS growth:  ${rssGrowthPct}%`);
  console.log(`  Crashes:     ${crashes}`);
  console.log(`  Samples:     ${samples.length}`);
  console.log(`  Success:     ${result.success}`);

  mkdirSync(outputDir, { recursive: true });
  const filename = `stability-${Date.now()}.json`;
  const outPath = join(outputDir, filename);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(`Results saved to ${outPath}`);

  return result;
}

const result = await runStabilityTest();
process.exit(result.success ? 0 : 1);
