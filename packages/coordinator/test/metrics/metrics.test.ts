import { describe, test, expect } from "bun:test";
import { MetricsRegistry, collectMetrics } from "../../src/metrics/index.js";
import { measureEventLoopLag } from "../../src/metrics/event-loop.js";

describe("MetricsRegistry", () => {
  test("gauge adds a metric entry", () => {
    const reg = new MetricsRegistry();
    reg.gauge("test_metric", "A test gauge", 42);
    const output = reg.format();
    expect(output).toContain("# HELP test_metric A test gauge");
    expect(output).toContain("# TYPE test_metric gauge");
    expect(output).toContain("test_metric 42");
  });

  test("gauge with labels produces label syntax", () => {
    const reg = new MetricsRegistry();
    reg.gauge("test_labeled", "Labeled gauge", 7, { env: "prod" });
    const output = reg.format();
    expect(output).toContain(`test_labeled{env="prod"} 7`);
  });

  test("counter adds a counter metric", () => {
    const reg = new MetricsRegistry();
    reg.counter("test_counter", "A counter", 100);
    const output = reg.format();
    expect(output).toContain("# TYPE test_counter counter");
    expect(output).toContain("test_counter 100");
  });

  test("format output ends with newline", () => {
    const reg = new MetricsRegistry();
    reg.gauge("x", "x", 0);
    expect(reg.format().endsWith("\n")).toBe(true);
  });

  test("clear removes all metrics", () => {
    const reg = new MetricsRegistry();
    reg.gauge("m", "m", 1);
    reg.clear();
    expect(reg.format()).toBe("\n");
  });

  test("multiple values for same metric name accumulate", () => {
    const reg = new MetricsRegistry();
    reg.gauge("multi", "multi gauge", 1, { shard: "a" });
    reg.gauge("multi", "multi gauge", 2, { shard: "b" });
    const output = reg.format();
    expect(output).toContain(`multi{shard="a"} 1`);
    expect(output).toContain(`multi{shard="b"} 2`);
  });
});

describe("collectMetrics", () => {
  test("populates all standard metrics", () => {
    const reg = new MetricsRegistry();
    collectMetrics(reg, {
      activeRuns: 3,
      queueDepth: 5,
      workers: 8,
      memoryRssMb: 64,
    });
    const output = reg.format();
    expect(output).toContain("openomni_active_runs 3");
    expect(output).toContain("openomni_queue_depth 5");
    expect(output).toContain("openomni_workers_total 8");
    expect(output).toContain("openomni_memory_rss_bytes");
  });

  test("includes wal_size_bytes only when walSizeMb is provided", () => {
    const regWithout = new MetricsRegistry();
    collectMetrics(regWithout, { activeRuns: 0, queueDepth: 0, workers: 0, memoryRssMb: 0 });
    expect(regWithout.format()).not.toContain("openomni_wal_size_bytes");

    const regWith = new MetricsRegistry();
    collectMetrics(regWith, {
      activeRuns: 0,
      queueDepth: 0,
      workers: 0,
      memoryRssMb: 0,
      walSizeMb: 2,
    });
    expect(regWith.format()).toContain("openomni_wal_size_bytes");
  });

  test("includes event_loop_lag_ms when provided", () => {
    const reg = new MetricsRegistry();
    collectMetrics(reg, {
      activeRuns: 0,
      queueDepth: 0,
      workers: 0,
      memoryRssMb: 0,
      eventLoopLagMs: 5,
    });
    expect(reg.format()).toContain("openomni_event_loop_lag_ms 5");
  });
});

describe("measureEventLoopLag", () => {
  test("returns a non-negative number", async () => {
    const lag = await measureEventLoopLag();
    expect(typeof lag).toBe("number");
    expect(lag).toBeGreaterThanOrEqual(0);
  });
});
