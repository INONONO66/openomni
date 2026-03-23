import { ExecutionEvent } from "@openomni/protocol";

const eventStore = new Map<string, ExecutionEvent.T[]>();
const completedSessions = new Set<string>();

export namespace EventLog {
  export async function append(
    sessionId: string,
    event: ExecutionEvent.T,
  ): Promise<void> {
    const events = eventStore.get(sessionId) ?? [];
    events.push(event);
    eventStore.set(sessionId, events);
  }

  export async function* replay(
    sessionId: string,
  ): AsyncGenerator<ExecutionEvent.T> {
    const events = eventStore.get(sessionId) ?? [];
    for (const event of events) {
      yield event;
    }
  }

  export async function listIncomplete(): Promise<string[]> {
    const allSessions = Array.from(eventStore.keys());
    return allSessions.filter((id) => !completedSessions.has(id));
  }

  export async function markComplete(sessionId: string): Promise<void> {
    completedSessions.add(sessionId);
  }

  export function _reset(): void {
    eventStore.clear();
    completedSessions.clear();
  }
}
