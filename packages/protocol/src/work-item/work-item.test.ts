import { describe, expect, test } from "bun:test";
import { WorkItem } from "./index.js";

const baseItem = {
  hash: "wi_000000000001",
  name: "Implement WorkItem namespace",
  sourceMessageId: "msg_1",
  sourceChannel: "discord",
  attempt: 1,
  timestamps: {
    created: 1,
    updated: 1,
  },
  relations: {
    childHashes: [],
    dependsOn: [],
  },
  intent: "build",
  goal: "add work item contracts",
  blockers: [],
  evidence: [],
  constraints: [],
  acceptanceCriteria: [],
  changedFiles: [],
};

describe("WorkItem.Info", () => {
  test("parses valid data", () => {
    const item = WorkItem.Info.parse(baseItem);

    expect(item.hash).toBe(baseItem.hash);
    expect(item.relations.childHashes).toEqual([]);
    expect(item.relations.dependsOn).toEqual([]);
  });

  test("rejects invalid data", () => {
    expect(() =>
      WorkItem.Info.parse({
        ...baseItem,
        sourceMessageId: undefined,
      }),
    ).toThrow();
  });
});

describe("WorkItem.deriveStatus", () => {
  test("returns cancelled when cancelled timestamp is set", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          cancelled: 4,
        },
      }),
    ).toBe("cancelled");
  });

  test("returns failed when failed timestamp is set", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          failed: 4,
        },
      }),
    ).toBe("failed");
  });

  test("returns completed when completed timestamp is set", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          completed: 4,
        },
      }),
    ).toBe("completed");
  });

  test("returns blocked when blocker is unresolved", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        blockers: [
          {
            id: "blk_1",
            description: "Waiting on dependency",
            kind: "dependency",
            createdAt: 2,
          },
        ],
      }),
    ).toBe("blocked");
  });

  test("returns running when started timestamp is set and no blockers exist", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          started: 3,
        },
      }),
    ).toBe("running");
  });

  test("returns pending when nothing is set", () => {
    expect(WorkItem.deriveStatus(WorkItem.Info.parse(baseItem))).toBe("pending");
  });

  test("prioritizes cancelled over completed", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          cancelled: 5,
          completed: 4,
        },
      }),
    ).toBe("cancelled");
  });
});

describe("WorkItem.generateHash", () => {
  test("produces wi_ hashes with 12 base36 characters", () => {
    const hashes = new Set<string>();

    for (let index = 0; index < 100; index += 1) {
      const hash = WorkItem.generateHash();

      expect(hash).toMatch(/^wi_[0-9a-z]{12}$/);
      hashes.add(hash);
    }

    expect(hashes.size).toBe(100);
  });
});

describe("WorkItem.Events", () => {
  test("exposes valid BusEvent descriptors", () => {
    const events = [
      WorkItem.Events.Created,
      WorkItem.Events.Updated,
      WorkItem.Events.StatusChanged,
      WorkItem.Events.Completed,
      WorkItem.Events.Failed,
      WorkItem.Events.Removed,
    ];

    for (const event of events) {
      expect(event.name).toBeString();
      expect(event.schema).toBeTruthy();
    }
  });
});
