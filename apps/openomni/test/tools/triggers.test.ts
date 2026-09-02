import { describe, expect, test } from "bun:test";
import { Trigger } from "@openomni/protocol";
import { catalogEntries, collectToolSpecs } from "../../src/tools/catalog";
import {
  TRIGGER_CANCEL_TOOL_NAME,
  TRIGGER_CREATE_TOOL_NAME,
  TRIGGER_LIST_TOOL_NAME,
  TRIGGER_REARM_TOOL_NAME,
  TriggerCreateToolInput,
  triggerCreateToolExecutor,
  triggerListToolExecutor,
  type TriggerToolPort,
} from "../../src/tools/triggers";

const RESIDENT = { role: "resident", depth: 0, sessionId: "owner-session" } as const;
const WORKER = { role: "worker", depth: 1, sessionId: "owner-session" } as const;
const TRIGGER_NAMES = [
  TRIGGER_CREATE_TOOL_NAME,
  TRIGGER_LIST_TOOL_NAME,
  TRIGGER_CANCEL_TOOL_NAME,
  TRIGGER_REARM_TOOL_NAME,
];

function record(overrides: Partial<Trigger.Record> = {}): Trigger.Record {
  return Trigger.Record.parse({
    id: "trigger-1",
    ownerSessionId: "owner-session",
    prompt: "Check this later",
    source: { kind: "time.once", at: 2_000 },
    lifecycle: { state: "armed" },
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    lastObservedAt: 1_000,
    fireCount: 0,
    coalescedFirePending: false,
    ...overrides,
  });
}

function port(overrides: Partial<TriggerToolPort> = {}): TriggerToolPort {
  return {
    create: async () => record(),
    list: async () => [record()],
    cancel: async () =>
      record({
        lifecycle: { state: "ended", endReason: "cancelled", endedAt: 2_000 },
      }),
    rearm: async () => record(),
    ...overrides,
  };
}

describe("Trigger tool schemas", () => {
  const valid = [
    { prompt: "wake", source: { kind: "time.once", at: 2_000 } },
    { prompt: "wake", source: { kind: "time.every", interval_ms: 1 } },
    { prompt: "watch", source: { kind: "event.command", command: "echo ok" } },
    { prompt: "watch", source: { kind: "event.file", path: "ready.txt" } },
  ];

  test("accepts each exact source branch", () => {
    for (const input of valid) expect(TriggerCreateToolInput.safeParse(input).success).toBe(true);
  });

  test("requires the selected fields and rejects every cross-branch field", () => {
    const invalid = [
      { prompt: "x", source: { kind: "time.once" } },
      { prompt: "x", source: { kind: "time.every", interval_ms: 1, at: 2 } },
      { prompt: "x", source: { kind: "event.command", command: "x", path: "x" } },
      { prompt: "x", source: { kind: "event.file", path: "x", persistent: true } },
      { prompt: "x", source: { kind: "event.file", path: "x", extra: true } },
    ];
    for (const input of invalid) expect(TriggerCreateToolInput.safeParse(input).success).toBe(false);
  });

  test("the advertised create schema stays flat at the root", () => {
    const spec = collectToolSpecs().find((candidate) => candidate.name === TRIGGER_CREATE_TOOL_NAME);
    const schema = spec?.inputSchema as Record<string, unknown>;
    expect(schema.oneOf).toBeUndefined();
    expect(schema.required).toEqual(["prompt", "source"]);
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      "prompt",
      "source",
    ]);
  });
});

describe("Trigger catalog authority", () => {
  test("registers all four specs through the sole catalog table", () => {
    const names = collectToolSpecs().map((spec) => spec.name);
    for (const name of TRIGGER_NAMES) expect(names).toContain(name);
  });

  test("offers all four only to a Resident when the port is wired", () => {
    const residentNames = catalogEntries({ triggers: port() }, RESIDENT).map(
      (entry) => entry.spec.name,
    );
    const workerNames = catalogEntries({ triggers: port() }, WORKER).map(
      (entry) => entry.spec.name,
    );
    for (const name of TRIGGER_NAMES) {
      expect(residentNames).toContain(name);
      expect(workerNames).not.toContain(name);
    }
  });

  test("binds the owner from origin rather than model input", async () => {
    const calls: Array<{ owner: string; input: unknown }> = [];
    const executor = triggerCreateToolExecutor(
      port({
        create: async (owner, input) => {
          calls.push({ owner, input });
          return record();
        },
      }),
      "owner-session",
    );

    await executor({ prompt: "wake", source: { kind: "time.once", at: 2_000 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.owner).toBe("owner-session");
    expect(calls[0]?.input).not.toHaveProperty("ownerSessionId");
  });
});

describe("Trigger tool machine results", () => {
  test("create projects exact snake-case identity and lifecycle fields", async () => {
    const output = await triggerCreateToolExecutor(port(), "owner-session")({
      prompt: "wake",
      source: { kind: "time.once", at: 2_000 },
    });
    expect(JSON.parse(output)).toEqual({
      trigger_id: "trigger-1",
      kind: "time.once",
      lifecycle: { state: "armed" },
    });
  });

  test("list includes scheduling counters but omits source secrets", async () => {
    const command = record({
      source: { kind: "event.command", command: "secret command", persistent: true },
      fireCount: 2,
      lastFiredAt: 3_000,
    });
    const output = await triggerListToolExecutor(
      port({ list: async () => [command] }),
      "owner-session",
    )({ include_ended: true });
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      triggers: [
        {
          trigger_id: "trigger-1",
          kind: "event.command",
          lifecycle: { state: "armed" },
          fire_count: 2,
          last_observed_at: 1_000,
          last_fired_at: 3_000,
        },
      ],
    });
    expect(output).not.toContain("secret command");
  });

  test("typed failures retain a machine-consumable code", async () => {
    const output = await triggerCreateToolExecutor(
      port({
        create: async () => {
          throw new Trigger.StoreError({
            code: "active_cap",
            message: "five active triggers already exist",
          });
        },
      }),
      "owner-session",
    )({ prompt: "wake", source: { kind: "time.once", at: 2_000 } });
    expect(JSON.parse(output)).toMatchObject({ error: { code: "active_cap" } });
  });
});
