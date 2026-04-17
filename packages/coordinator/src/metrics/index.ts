// Prometheus exposition format
// https://prometheus.io/docs/instrumenting/exposition_formats/

type MetricValue = {
  labels?: Record<string, string>;
  value: number;
};

type Metric = {
  name: string;
  help: string;
  type: "gauge" | "counter" | "histogram";
  values: MetricValue[];
};

export class MetricsRegistry {
  private metrics = new Map<string, Metric>();

  gauge(name: string, help: string, value: number, labels?: Record<string, string>): void {
    const existing = this.metrics.get(name) ?? { name, help, type: "gauge" as const, values: [] };
    existing.values.push({ labels, value });
    this.metrics.set(name, existing);
  }

  counter(name: string, help: string, value: number, labels?: Record<string, string>): void {
    const existing = this.metrics.get(name) ?? {
      name,
      help,
      type: "counter" as const,
      values: [],
    };
    existing.values.push({ labels, value });
    this.metrics.set(name, existing);
  }

  format(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const { labels, value } of metric.values) {
        const labelStr =
          labels && Object.keys(labels).length > 0
            ? `{${Object.entries(labels)
                .map(([k, v]) => `${k}="${v}"`)
                .join(",")}}`
            : "";
        lines.push(`${metric.name}${labelStr} ${value}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  clear(): void {
    this.metrics.clear();
  }
}

export type MetricsSnapshot = {
  activeRuns: number;
  queueDepth: number;
  workers: number;
  walSizeMb?: number;
  memoryRssMb: number;
  eventLoopLagMs?: number;
};

export function collectMetrics(registry: MetricsRegistry, stats: MetricsSnapshot): void {
  registry.clear();
  registry.gauge("openomni_active_runs", "Number of active runs", stats.activeRuns);
  registry.gauge("openomni_queue_depth", "Number of queued runs", stats.queueDepth);
  registry.gauge("openomni_workers_total", "Total worker count", stats.workers);
  registry.gauge(
    "openomni_memory_rss_bytes",
    "Process RSS memory",
    stats.memoryRssMb * 1024 * 1024,
    { process: "coordinator" },
  );
  if (stats.walSizeMb !== undefined) {
    registry.gauge(
      "openomni_wal_size_bytes",
      "SQLite WAL file size",
      stats.walSizeMb * 1024 * 1024,
    );
  }
  if (stats.eventLoopLagMs !== undefined) {
    registry.gauge(
      "openomni_event_loop_lag_ms",
      "Event loop lag in milliseconds",
      stats.eventLoopLagMs,
    );
  }
}
