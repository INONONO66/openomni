import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Todo } from "../../src/todo/index";
import { Bus } from "../../src/bus/index";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { Todo as TodoProtocol } from "@openomni/protocol";

function makeTodo(overrides: Partial<TodoProtocol.Info> = {}): TodoProtocol.Info {
  return {
    id: "todo-1",
    sessionId: "sess-1",
    content: "do something",
    status: "pending",
    priority: "medium",
    position: 0,
    ...overrides,
  };
}

function seedSession(id: string): void {
  const now = Date.now();
  Storage.get().session.set(id, {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
  seedSession("sess-1");
  seedSession("sess-2");
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("Todo.get", () => {
  it("returns empty array when todo storage is absent", async () => {
    const adapter = Storage.get();
    const noTodoAdapter = { ...adapter, todo: undefined };
    Storage.configure(noTodoAdapter);

    const result = await Todo.get("sess-1");
    expect(result).toEqual([]);
  });

  it("returns todos for a session", async () => {
    const todos = [makeTodo({ id: "t1", position: 0 }), makeTodo({ id: "t2", position: 1 })];
    await Todo.update("sess-1", todos);

    const result = await Todo.get("sess-1");
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toContain("t1");
    expect(result.map((t) => t.id)).toContain("t2");
  });

  it("returns empty array for session with no todos", async () => {
    const result = await Todo.get("unknown-session");
    expect(result).toEqual([]);
  });

  it("isolates todos between sessions", async () => {
    await Todo.update("sess-1", [makeTodo({ id: "t1", sessionId: "sess-1" })]);
    await Todo.update("sess-2", [makeTodo({ id: "t2", sessionId: "sess-2" })]);

    const s1 = await Todo.get("sess-1");
    const s2 = await Todo.get("sess-2");
    expect(s1).toHaveLength(1);
    expect(s1[0].id).toBe("t1");
    expect(s2).toHaveLength(1);
    expect(s2[0].id).toBe("t2");
  });
});

describe("Todo.update", () => {
  it("throws when todo storage is not configured", async () => {
    const adapter = Storage.get();
    const noTodoAdapter = { ...adapter, todo: undefined };
    Storage.configure(noTodoAdapter);

    await expect(Todo.update("sess-1", [])).rejects.toThrow("Todo storage not configured");
  });

  it("persists todos and they are retrievable via get", async () => {
    const todos = [makeTodo()];
    await Todo.update("sess-1", todos);

    const result = await Todo.get("sess-1");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("do something");
  });

  it("replaces existing todos on subsequent updates", async () => {
    await Todo.update("sess-1", [makeTodo({ id: "t1", content: "old" })]);
    await Todo.update("sess-1", [makeTodo({ id: "t2", content: "new" })]);

    const result = await Todo.get("sess-1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t2");
    expect(result[0].content).toBe("new");
  });

  it("publishes todo.updated bus event", async () => {
    const received: { sessionId: string; todos: TodoProtocol.Info[] }[] = [];
    Bus.subscribe(TodoProtocol.Updated, (data) => received.push(data));

    const todos = [makeTodo()];
    await Todo.update("sess-1", todos);

    // Bus.publish dispatches via queueMicrotask
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0].sessionId).toBe("sess-1");
    expect(received[0].todos).toHaveLength(1);
  });

  it("preserves todo fields through round-trip", async () => {
    const todo = makeTodo({
      id: "t-full",
      content: "detailed task",
      status: "in_progress",
      priority: "high",
      position: 3,
    });
    await Todo.update("sess-1", [todo]);

    const [result] = await Todo.get("sess-1");
    expect(result.id).toBe("t-full");
    expect(result.content).toBe("detailed task");
    expect(result.status).toBe("in_progress");
    expect(result.priority).toBe("high");
    expect(result.position).toBe(3);
  });
});
