import { ExecutionEvent } from "@openomni/protocol";
import { join } from "node:path";
import { Storage } from "../storage/storage";
import { FileEventLog } from "./file-event-log";

function resolveDefaultEventLogDir(): string {
  const adapter = Storage.get();
  const maybeWrapped = adapter as Storage.Adapter & {
    underlying?: unknown;
  };
  const maybeUnderlying = maybeWrapped.underlying as { baseDir?: string } | undefined;

  const maybeDirect = adapter as Storage.Adapter & { baseDir?: string };
  const baseDir = maybeDirect.baseDir ?? maybeUnderlying?.baseDir;
  if (baseDir) {
    return join(baseDir, "event-log");
  }

  return join(process.cwd(), ".openomni", "event-log");
}

let backend: FileEventLog | null = null;
let explicitlyConfigured = false;

function getBackend(): FileEventLog {
  if (!backend) {
    backend = new FileEventLog(resolveDefaultEventLogDir());
  }
  return backend;
}

function getAdapter(): Storage.Adapter["eventLog"] | undefined {
  if (explicitlyConfigured) return undefined;
  return Storage.get().eventLog;
}

export namespace EventLog {
  export function configure(baseDir: string): void {
    backend = new FileEventLog(baseDir) as FileEventLog;
    explicitlyConfigured = true;
  }

  export async function append(sessionId: string, event: ExecutionEvent.T): Promise<void> {
    const adapter = getAdapter();
    if (adapter) {
      adapter.append(sessionId, event.type, JSON.stringify(event));
    } else {
      getBackend().append(sessionId, event);
    }
  }

  export async function* replay(sessionId: string): AsyncGenerator<ExecutionEvent.T> {
    const adapter = getAdapter();
    if (adapter) {
      for (const row of adapter.replay(sessionId)) {
        const parsed = ExecutionEvent.Schema.safeParse(JSON.parse(row.data));
        if (parsed.success) {
          yield parsed.data;
        }
      }
    } else {
      for (const event of getBackend().replay(sessionId)) {
        yield event;
      }
    }
  }

  export async function listIncomplete(): Promise<string[]> {
    const adapter = getAdapter();
    if (adapter) {
      return adapter.listIncompleteSessions();
    }
    return getBackend().listIncomplete();
  }

  export async function markComplete(sessionId: string): Promise<void> {
    const adapter = getAdapter();
    if (adapter) {
      const incomplete = adapter.listIncomplete(sessionId);
      for (const event of incomplete) {
        adapter.markComplete(sessionId, event.id);
      }
    } else {
      getBackend().markComplete(sessionId);
    }
  }

  export async function remove(sessionId: string): Promise<void> {
    const adapter = getAdapter();
    if (!adapter) {
      getBackend().clear(sessionId);
    }
  }

  export function _reset(): void {
    backend?.clearAll();
    backend = null;
    explicitlyConfigured = false;
  }
}
