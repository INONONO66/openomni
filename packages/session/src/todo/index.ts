import { Todo as TodoProtocol } from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import { Bus } from "../bus/index.js";

export namespace Todo {
  export type Info = TodoProtocol.Info;

  export async function update(sessionId: string, todos: TodoProtocol.Info[]): Promise<void> {
    const adapter = Storage.get();
    if (!adapter.todo) throw new Error("Todo storage not configured");
    const normalized = todos.map((t) => (t.sessionId !== sessionId ? { ...t, sessionId } : t));
    await adapter.todo.upsertAll(sessionId, normalized);
    Bus.publish(TodoProtocol.Updated, { sessionId, todos: normalized });
  }

  export async function get(sessionId: string): Promise<TodoProtocol.Info[]> {
    const adapter = Storage.get();
    if (!adapter.todo) return [];
    return adapter.todo.list(sessionId);
  }
}
