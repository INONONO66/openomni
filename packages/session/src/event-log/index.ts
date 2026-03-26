import { ExecutionEvent } from "@openomni/protocol";
import { join } from "node:path";
import { Storage } from "../storage/storage";
import { FileEventLog } from "./file-event-log";

function resolveDefaultEventLogDir(): string {
  const adapter = Storage.get();
  const maybeWrapped = adapter as Storage.Adapter & {
    underlying?: unknown;
  };
  const maybeUnderlying = maybeWrapped.underlying as
    | { baseDir?: string }
    | undefined;

  const maybeDirect = adapter as Storage.Adapter & { baseDir?: string };
  const baseDir = maybeDirect.baseDir ?? maybeUnderlying?.baseDir;
  if (baseDir) {
    return join(baseDir, "event-log");
  }

  return join(process.cwd(), ".openomni", "event-log");
}

let backend = new FileEventLog(resolveDefaultEventLogDir());

export namespace EventLog {
  export function configure(baseDir: string): void {
    backend = new FileEventLog(baseDir);
  }

  export async function append(
    sessionId: string,
    event: ExecutionEvent.T,
  ): Promise<void> {
    backend.append(sessionId, event);
  }

  export async function* replay(
    sessionId: string,
  ): AsyncGenerator<ExecutionEvent.T> {
    for (const event of backend.replay(sessionId)) {
      yield event;
    }
  }

  export async function listIncomplete(): Promise<string[]> {
    return backend.listIncomplete();
  }

  export async function markComplete(sessionId: string): Promise<void> {
    backend.markComplete(sessionId);
  }

  export async function remove(sessionId: string): Promise<void> {
    backend.clear(sessionId);
  }

  export function _reset(): void {
    backend.clearAll();
  }
}
