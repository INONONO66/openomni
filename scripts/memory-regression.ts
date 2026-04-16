// Run with: bun --expose-gc scripts/memory-regression.ts

import { writeFileSync } from "node:fs";
import { Session } from "../packages/session/src/index.ts";

const RUNS = 100;
const DATE = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const MODEL = { providerID: "test", modelID: "test" };

async function measureMemory() {
  // force GC before measurement to get a clean baseline
  if (typeof Bun !== "undefined" && "gc" in Bun) {
    (Bun as any).gc(true);
  }

  const before = process.memoryUsage();

  for (let i = 0; i < RUNS; i++) {
    const session = Session.create({ title: `test-${i}`, model: MODEL });
    for (let j = 0; j < 10; j++) {
      Session.addMessage(session.id, {
        id: crypto.randomUUID(),
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: MODEL,
      });
    }
  }

  const afterLoad = process.memoryUsage();

  // force GC to distinguish live heap from retained garbage
  if (typeof Bun !== "undefined" && "gc" in Bun) {
    (Bun as any).gc(true);
  }

  const afterGC = process.memoryUsage();

  return {
    runs: RUNS,
    before_heap_mb: Math.round((before.heapUsed / 1024 / 1024) * 100) / 100,
    after_load_heap_mb: Math.round((afterLoad.heapUsed / 1024 / 1024) * 100) / 100,
    after_gc_heap_mb: Math.round((afterGC.heapUsed / 1024 / 1024) * 100) / 100,
    heap_growth_mb: Math.round(((afterLoad.heapUsed - before.heapUsed) / 1024 / 1024) * 100) / 100,
    residual_mb: Math.round(((afterGC.heapUsed - before.heapUsed) / 1024 / 1024) * 100) / 100,
    rss_before_mb: Math.round((before.rss / 1024 / 1024) * 100) / 100,
    rss_after_mb: Math.round((afterGC.rss / 1024 / 1024) * 100) / 100,
    threshold: {
      regression_if_residual_exceeds_mb: "baseline_residual_mb * 1.3",
      note: "If residual_mb after a future run exceeds baseline * 1.3, it's a regression",
    },
    measured_at: new Date().toISOString(),
  };
}

const result = await measureMemory();
console.log(JSON.stringify(result, null, 2));

const outPath = `.sisyphus/evidence/memory-baseline-${DATE}.json`;
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.error(`Baseline saved to ${outPath}`);
