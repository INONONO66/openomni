import { beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../../src/storage/storage";
import { createWorkItem } from "../../src/work-item/create";
import "../../src/storage/initialize";

describe("work-item writes fail closed (#606 audit)", () => {
  beforeEach(() => {
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
});
