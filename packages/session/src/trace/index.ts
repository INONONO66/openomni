import type { TraceContext as TraceContextType } from "@openomni/protocol";

export namespace TraceContext {
  export function create(overrides?: Partial<TraceContextType.Type>): TraceContextType.Type {
    return { traceId: crypto.randomUUID(), ...overrides };
  }

  export function child(
    parent: TraceContextType.Type,
    overrides?: Partial<TraceContextType.Type>,
  ): TraceContextType.Type {
    return { ...parent, ...overrides };
  }

  export function empty(): TraceContextType.Type {
    return { traceId: crypto.randomUUID() };
  }
}
