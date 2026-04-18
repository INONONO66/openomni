import { ExecutionEvent } from "@openomni/protocol";
import { Storage } from "../storage/storage";

function getAdapter(): Storage.Adapter["eventLog"] | undefined {
  return Storage.get().eventLog;
}

export namespace EventLog {
  export async function append(sessionId: string, event: ExecutionEvent): Promise<void> {
    const adapter = getAdapter();
    if (adapter) {
      adapter.append(sessionId, event.type, JSON.stringify(event));
    }
  }

  export async function* replay(sessionId: string): AsyncGenerator<ExecutionEvent> {
    const adapter = getAdapter();
    if (adapter) {
      for (const row of adapter.replay(sessionId)) {
        try {
          const parsed = ExecutionEvent.Schema.safeParse(JSON.parse(row.data));
          if (parsed.success) {
            yield parsed.data;
          }
        } catch (_) {
          /* malformed event row — skip */
        }
      }
    }
  }

  export async function listIncomplete(): Promise<string[]> {
    const adapter = getAdapter();
    if (adapter) {
      return adapter.listIncompleteSessions();
    }
    return [];
  }

  export async function markComplete(sessionId: string): Promise<void> {
    const adapter = getAdapter();
    if (adapter) {
      const incomplete = adapter.listIncomplete(sessionId);
      for (const event of incomplete) {
        adapter.markComplete(sessionId, event.id);
      }
    }
  }

  export async function remove(_sessionId: string): Promise<void> {
    // no-op — SQLite handles cascade deletion via FK
  }

  export function _reset(): void {
    // no-op — SQLite adapter reset handled by Storage.configure()
  }
}
