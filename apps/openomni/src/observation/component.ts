import { Bus } from "@openomni/agent";
import { type BusEvent, Component, type TraceContext } from "@openomni/protocol";

export interface ObservedComponent {
  readonly events: BusEvent.Sink;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

interface ComponentIdentity extends TraceContext.Type {
  readonly actorId?: string;
  readonly pluginName?: string;
  readonly pluginVersion?: string;
  readonly configRevision?: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly componentId: string;
  readonly componentGeneration: number;
}

/** App-owned component observation sink behind the protocol port. */
export function observeComponent(trace: ComponentIdentity): ObservedComponent {
  const events = Bus.scope?.({
    traceId: trace.traceId,
    sessionId: trace.sessionId,
    runId: trace.runId,
    actorId: trace.actorId,
    agentName: trace.agentName,
    componentId: trace.componentId,
    componentGeneration: trace.componentGeneration,
    pluginName: trace.pluginName,
    pluginVersion: trace.pluginVersion,
    configRevision: trace.configRevision,
  }) ?? Bus;

  return {
    events,
    async run(operation) {
      events.publish(Component.Events.Active, componentPayload(trace));
      try {
        const result = await operation();
        events.publish(Component.Events.Disposed, {
          ...componentPayload(trace),
          outcome: "completed",
        });
        return result;
      } catch (error) {
        let message: string;
        try {
          message = error instanceof Error ? error.message : String(error);
        } catch {
          message = "unprintable error";
        }
        events.publish(Component.Events.Failed, { ...componentPayload(trace), error: message });
        events.publish(Component.Events.Disposed, {
          ...componentPayload(trace),
          outcome: "failed",
        });
        throw error;
      }
    },
  };
}

function componentPayload(trace: ComponentIdentity) {
  return {
    eventId: "scoped",
    traceId: trace.traceId,
    spanId: trace.parentSpanId ?? trace.traceId.slice(0, 16),
    sessionId: trace.sessionId,
    runId: trace.runId,
    componentId: trace.componentId,
    componentGeneration: trace.componentGeneration,
    time: 0,
  };
}
