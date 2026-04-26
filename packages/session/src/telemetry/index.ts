import {
  trace,
  metrics,
  context,
  SpanStatusCode,
  type Tracer,
  type Meter,
  type Span,
} from "@opentelemetry/api";

export interface TelemetryConfig {
  enabled: boolean;
  serviceName?: string;
}

const TRACER_NAME = "openomni";
const METER_NAME = "openomni";

let _config: TelemetryConfig = { enabled: false };
let _tracer: Tracer | null = null;
let _meter: Meter | null = null;

export namespace Telemetry {
  export function init(config: TelemetryConfig): void {
    _config = config;
    if (config.enabled) {
      _tracer = trace.getTracer(TRACER_NAME);
      _meter = metrics.getMeter(METER_NAME);
    } else {
      _tracer = null;
      _meter = null;
    }
  }

  export async function span<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>,
  ): Promise<T> {
    if (!_config.enabled || !_tracer) {
      return fn(noopSpan());
    }

    const span = _tracer.startSpan(name, { attributes });
    const ctx = trace.setSpan(context.active(), span);

    try {
      const result = await context.with(ctx, () => fn(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  }

  export function counter(name: string): {
    add: (value: number, attributes?: Record<string, string | number | boolean>) => void;
  } {
    if (!_config.enabled || !_meter) {
      return {
        add: () => {
          // noop when telemetry disabled
        },
      };
    }
    const counter = _meter.createCounter(name);
    return {
      add: (value, attributes) => counter.add(value, attributes),
    };
  }

  export function histogram(name: string): {
    record: (value: number, attributes?: Record<string, string | number | boolean>) => void;
  } {
    if (!_config.enabled || !_meter) {
      return {
        record: () => {
          // noop when telemetry disabled
        },
      };
    }
    const histogram = _meter.createHistogram(name);
    return {
      record: (value, attributes) => histogram.record(value, attributes),
    };
  }

  export function isEnabled(): boolean {
    return _config.enabled;
  }

  export function reset(): void {
    _config = { enabled: false };
    _tracer = null;
    _meter = null;
  }
}

function noopSpan(): Span {
  return trace.wrapSpanContext({
    traceId: "00000000000000000000000000000000",
    spanId: "0000000000000000",
    traceFlags: 0,
    isRemote: false,
  });
}
