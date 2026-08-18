import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../../src/storage/storage";
import { createWorkItem } from "../../src/work-item/create";
import { WorkItemStore } from "../../src/work-item/index";
import { mutate } from "../../src/work-item/mutation";
import "../../src/storage/initialize";

describe("work-item writes fail closed (#606 audit)", () => {
  beforeEach(() => {
    Storage.reset();
  });

  afterEach(() => {
    Storage.reset();
  });

  test("create refuses without the workItem adapter — no phantom Info", async () => {
    // Bare storage: no workItem sub-adapter. The old path warned and returned
    // a fabricated, never-persisted Info whose hash looked real.
    Storage.initialize({ dbPath: ":memory:" });
    const adapter = Storage.getAdapter();
    Object.defineProperty(Storage.get(), "workItem", { value: undefined, configurable: true });

    await expect(
      createWorkItem(
        {
          name: "phantom",
          sourceMessageId: "msg-1",
          sourceChannel: "test",
          intent: "test",
          goal: "never persisted",
          acceptanceCriteria: ["none"],
          sessionId: "ses-1",
        },
        "trace-failclosed",
      ),
    ).rejects.toThrow("refusing to fabricate");
    void adapter;
  });

  test("mutate refuses without the workItem adapter — no silent not-found", async () => {
    // The old path returned undefined, indistinguishable from "work item
    // not found" — a lifecycle write silently skipped.
    Storage.initialize({ dbPath: ":memory:" });
    Object.defineProperty(Storage.get(), "workItem", { value: undefined, configurable: true });

    await expect(
      mutate("hash-absent-adapter", "trace-failclosed", (existing) => ({
        updated: existing,
        changedFields: [],
        fact: { type: "work_item.updated", data: {} },
      })),
    ).rejects.toThrow("refusing to skip a work-item mutation");
  });

  test("store lifecycle writers refuse without the workItem adapter", async () => {
    // Every public lifecycle writer rides mutate(); the fail-closed throw
    // above must surface through the store surface too.
    Storage.initialize({ dbPath: ":memory:" });
    Object.defineProperty(Storage.get(), "workItem", { value: undefined, configurable: true });

    await expect(WorkItemStore.start("hash-absent-adapter", "trace-failclosed")).rejects.toThrow(
      "refusing to skip a work-item mutation",
    );
  });
});
