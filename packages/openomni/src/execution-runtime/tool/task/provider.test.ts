import { beforeEach, describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { TaskToolProvider } from "./provider.js";

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: "call-1", tool, input };
}

describe("TaskToolProvider", () => {
  let provider: TaskToolProvider;

  beforeEach(() => {
    Storage.reset();
    provider = new TaskToolProvider();
  });

  it("has correct name and category", () => {
    expect(provider.name).toBe("task");
    expect(provider.category).toBe("agent");
  });

  it("listTools returns 4 tools", () => {
    const tools = provider.listTools();
    expect(tools.length).toBe(4);
    const names = tools.map((t) => t.spec.name);
    expect(names).toContain("task_create");
    expect(names).toContain("task_get");
    expect(names).toContain("task_list");
    expect(names).toContain("task_update");
  });

  it("task_create and task_get have correct riskTier", () => {
    const tools = provider.listTools();
    const create = tools.find((t) => t.spec.name === "task_create")!;
    const get = tools.find((t) => t.spec.name === "task_get")!;
    const list = tools.find((t) => t.spec.name === "task_list")!;
    const update = tools.find((t) => t.spec.name === "task_update")!;

    expect(create.riskTier).toBe(1);
    expect(get.riskTier).toBe(0);
    expect(list.riskTier).toBe(0);
    expect(update.riskTier).toBe(1);

    expect(get.isReadOnly).toBe(true);
    expect(list.isReadOnly).toBe(true);
  });

  describe("task_create", () => {
    it("creates a task and returns JSON", async () => {
      const result = await provider.execute(
        makeCall("task_create", {
          id: "t1",
          title: "My Task",
          owner: { type: "user", id: "u1" },
        }),
      );

      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.output);
      expect(task.id).toBe("t1");
      expect(task.title).toBe("My Task");
      expect(task.owner.type).toBe("user");
      expect(task.owner.id).toBe("u1");
      expect(task.status).toBe("idle");
    });

    it("creates a task with optional description and tags", async () => {
      const result = await provider.execute(
        makeCall("task_create", {
          id: "t2",
          title: "Tagged Task",
          description: "A description",
          owner: { type: "agent", id: "ag1" },
          status: "scheduled",
          tags: ["alpha", "beta"],
        }),
      );

      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.output);
      expect(task.description).toBe("A description");
      expect(task.tags).toEqual(["alpha", "beta"]);
      expect(task.status).toBe("scheduled");
    });

    it("returns error when id is missing", async () => {
      const result = await provider.execute(
        makeCall("task_create", { title: "No ID", owner: { type: "user", id: "u1" } }),
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when owner is missing", async () => {
      const result = await provider.execute(
        makeCall("task_create", { id: "t3", title: "No Owner" }),
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("task_get", () => {
    it("returns a created task", async () => {
      await provider.execute(
        makeCall("task_create", { id: "t10", title: "Get Me", owner: { type: "user", id: "u2" } }),
      );

      const result = await provider.execute(makeCall("task_get", { id: "t10" }));
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.output);
      expect(task.id).toBe("t10");
      expect(task.title).toBe("Get Me");
    });

    it("returns error for non-existent task", async () => {
      const result = await provider.execute(makeCall("task_get", { id: "nope" }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("returns error when id is missing", async () => {
      const result = await provider.execute(makeCall("task_get", {}));
      expect(result.isError).toBe(true);
    });
  });

  describe("task_list", () => {
    beforeEach(async () => {
      await provider.execute(
        makeCall("task_create", {
          id: "l1",
          title: "Task 1",
          owner: { type: "user", id: "u1" },
          status: "idle",
        }),
      );
      await provider.execute(
        makeCall("task_create", {
          id: "l2",
          title: "Task 2",
          owner: { type: "agent", id: "ag1" },
          status: "running",
        }),
      );
      await provider.execute(
        makeCall("task_create", {
          id: "l3",
          title: "Task 3",
          owner: { type: "user", id: "u1" },
          status: "done",
        }),
      );
    });

    it("returns all tasks when no filter", async () => {
      const result = await provider.execute(makeCall("task_list", {}));
      expect(result.isError).toBeUndefined();
      const tasks = JSON.parse(result.output);
      expect(tasks.length).toBe(3);
    });

    it("filters by status", async () => {
      const result = await provider.execute(makeCall("task_list", { status: "running" }));
      expect(result.isError).toBeUndefined();
      const tasks = JSON.parse(result.output);
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("l2");
    });

    it("filters by ownerId", async () => {
      const result = await provider.execute(makeCall("task_list", { ownerId: "u1" }));
      expect(result.isError).toBeUndefined();
      const tasks = JSON.parse(result.output);
      expect(tasks.length).toBe(2);
      expect(tasks.every((t: { owner: { id: string } }) => t.owner.id === "u1")).toBe(true);
    });
  });

  describe("task_update", () => {
    beforeEach(async () => {
      await provider.execute(
        makeCall("task_create", {
          id: "u10",
          title: "Updatable",
          owner: { type: "user", id: "u1" },
        }),
      );
    });

    it("updates status and returns updated task", async () => {
      const result = await provider.execute(
        makeCall("task_update", { id: "u10", status: "running" }),
      );
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.output);
      expect(task.id).toBe("u10");
      expect(task.status).toBe("running");
      expect(task.title).toBe("Updatable");
    });

    it("updates title", async () => {
      const result = await provider.execute(
        makeCall("task_update", { id: "u10", title: "New Title" }),
      );
      expect(result.isError).toBeUndefined();
      const task = JSON.parse(result.output);
      expect(task.title).toBe("New Title");
    });

    it("persists the update (verify via task_get)", async () => {
      await provider.execute(makeCall("task_update", { id: "u10", status: "done" }));
      const result = await provider.execute(makeCall("task_get", { id: "u10" }));
      const task = JSON.parse(result.output);
      expect(task.status).toBe("done");
    });

    it("returns error for non-existent task", async () => {
      const result = await provider.execute(
        makeCall("task_update", { id: "nope", status: "done" }),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("returns error when id is missing", async () => {
      const result = await provider.execute(makeCall("task_update", {}));
      expect(result.isError).toBe(true);
    });
  });

  describe("execute", () => {
    it("returns error for unknown tool", async () => {
      const result = await provider.execute(makeCall("task_nonexistent"));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Unknown tool");
    });
  });
});
