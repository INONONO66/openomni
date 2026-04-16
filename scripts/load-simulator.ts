// Load simulator for OpenOmni coordinator
// Usage: bun scripts/load-simulator.ts --streams 50 --duration 5m
// Simulates N concurrent fake LLM streams without real API calls

import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    streams: { type: "string", default: "50" },
    duration: { type: "string", default: "5m" },
    output: { type: "string", default: ".sisyphus/evidence" },
  },
});

const streamCount = parseInt(values.streams ?? "50", 10);
const durationMs = parseDuration(values.duration ?? "5m");
const outputDir = values.output ?? ".sisyphus/evidence";

function parseDuration(s: string): number {
  if (s.endsWith("s")) return parseInt(s) * 1000;
  if (s.endsWith("m")) return parseInt(s) * 60 * 1000;
  if (s.endsWith("h")) return parseInt(s) * 3600 * 1000;
  return parseInt(s);
}

async function* fakeStream(id: number, streamDurationMs: number): AsyncGenerator<string> {
  const start = Date.now();
  const tokensPerSecond = 20 + Math.random() * 30; // 20-50 tokens/sec
  const tokenInterval = 1000 / tokensPerSecond;

  while (Date.now() - start < streamDurationMs) {
    yield `token-${id}-${Date.now()}`;
    await new Promise((r) => setTimeout(r, tokenInterval));
  }
}

// Measure event loop lag via setImmediate round-trip
async function measureLag(): Promise<number> {
  const start = Date.now();
  await new Promise((r) => setImmediate(r));
  return Date.now() - start;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

async function runLoadTest() {
  console.log(`Starting load test: ${streamCount} streams for ${values.duration}`);

  const startTime = Date.now();
  let totalTokens = 0;
  let errors = 0;
  const lagSamples: number[] = [];

  const lagInterval = setInterval(async () => {
    lagSamples.push(await measureLag());
  }, 1000);

  const streams = Array.from({ length: streamCount }, (_, i) =>
    (async () => {
      try {
        for await (const _token of fakeStream(i, durationMs)) {
          totalTokens++;
        }
      } catch {
        errors++;
      }
    })(),
  );

  await Promise.all(streams);
  clearInterval(lagInterval);

  const elapsed = Date.now() - startTime;
  const memUsage = process.memoryUsage();

  const lagP95 = percentile(lagSamples, 95);

  const result = {
    streams: streamCount,
    duration_ms: elapsed,
    total_tokens: totalTokens,
    tokens_per_second: Math.round(totalTokens / (elapsed / 1000)),
    errors,
    event_loop_lag_p50_ms: percentile(lagSamples, 50),
    event_loop_lag_p95_ms: lagP95,
    event_loop_lag_p99_ms: percentile(lagSamples, 99),
    memory_rss_mb: Math.round(memUsage.rss / 1024 / 1024),
    memory_heap_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
    success: errors === 0 && lagP95 < 50,
    measured_at: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  mkdirSync(outputDir, { recursive: true });
  const filename = `load-simulator-${Date.now()}.json`;
  writeFileSync(join(outputDir, filename), JSON.stringify(result, null, 2));
  console.error(`Results saved to ${join(outputDir, filename)}`);

  return result;
}

const result = await runLoadTest();
process.exit(result.success ? 0 : 1);
