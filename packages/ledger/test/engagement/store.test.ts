import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engagement } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { EngagementStore, Storage } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

const T0 = 1_700_000_000_000;

function buildCreate(overrides: Partial<Engagement.Create> = {}): Engagement.Create {
  return {
    id: "eng-1",
    ownerSessionId: "ses-owner",
    title: "sell bike, floor 50000",
    terms: { spendCeiling: 50_000 },
    ...overrides,
  };
}

function move(
  id: string,
  to: Engagement.State,
  extra: Partial<Engagement.TransitionInput> = {},
): Engagement.Outcome {
  return EngagementStore.transition(
    id,
    { to, at: T0 + 1_000, reason: "test move", ...extra },
    "trace-move",
  );
}

describe("EngagementStore.open", () => {
  test("records the opened fact, projects the row, publishes user_audit Opened", async () => {
    const events: Array<{ name: string; data: unknown }> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("engagement.")) events.push({ name: event.name, data });
    });

    const record = EngagementStore.open(buildCreate(), "trace-open", T0);
    expect(record.state).toBe("planning");
    expect(record.revision).toBe(1);
    expect(EngagementStore.get("eng-1")).toEqual(record);

    const head = Storage.get().ledger?.headFact("engagement:eng-1");
    expect(head?.type).toBe("engagement.opened");
    expect(head?.seq).toBe(1);

    await flushBus();
    expect(events).toEqual([
      {
        name: "engagement.opened",
        data: {
          id: "eng-1",
          traceId: "trace-open",
          ownerSessionId: "ses-owner",
          time: T0,
          title: "sell bike, floor 50000",
          state: "planning",
        },
      },
    ]);
    expect(Engagement.Events.Opened.visibility).toBe("user_audit");
  });

  test("lists stored engagements without a filter", () => {
    EngagementStore.open(buildCreate(), "trace-open", T0);
    expect(EngagementStore.list().map(({ id }) => id)).toEqual(["eng-1"]);
  });

  test("duplicate id is a typed duplicate and writes nothing", () => {
    EngagementStore.open(buildCreate(), "trace-open", T0);
    let error: unknown;
    try {
      EngagementStore.open(buildCreate(), "trace-open-2", T0 + 1);
    } catch (caught) {
      error = caught;
    }
    expect(Engagement.StoreError.isInstance(error)).toBe(true);
    expect((error as Engagement.StoreError).data.code).toBe("duplicate");
    expect(EngagementStore.get("eng-1")?.createdAt).toBe(T0);
  });

  test("the opened fact never carries the delegation title (erasable content stays off the chain)", () => {
    EngagementStore.open(buildCreate(), "trace-open", T0);
    const head = Storage.get().ledger?.headFact("engagement:eng-1");
    expect(JSON.stringify(head?.data)).not.toContain("sell bike");
  });
});

describe("EngagementStore.transition", () => {
  test("append-before-CAS: fact seq tracks projected revision", () => {
    EngagementStore.open(buildCreate(), "trace-open", T0);
    const outcome = move("eng-1", "deliberating");
    expect(outcome.kind).toBe("transitioned");
    expect(outcome.record.revision).toBe(2);
    const head = Storage.get().ledger?.headFact("engagement:eng-1");
    expect(head?.type).toBe("engagement.transitioned");
    expect(head?.seq).toBe(2);
    expect(EngagementStore.get("eng-1")?.state).toBe("deliberating");
  });

  test("a reported term crossing forces awaiting_user_approval and audits forced=true", async () => {
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    Bus.observe((event, data) => {
      if (event.name === "engagement.transitioned")
        events.push({ name: event.name, data: data as Record<string, unknown> });
    });
    EngagementStore.open(buildCreate(), "trace-open", T0);
    move("eng-1", "deliberating");
    const outcome = move("eng-1", "acting", { termCrossed: true, reason: "price below floor" });
    expect(outcome.kind).toBe("forced_approval");
    expect(EngagementStore.get("eng-1")?.state).toBe("awaiting_user_approval");
    await flushBus();
    expect(events.at(-1)?.data).toMatchObject({
      from: "deliberating",
      to: "awaiting_user_approval",
      forced: true,
      reason: "price below floor",
    });
  });

  test("rejections persist nothing and publish the internal rejection event", async () => {
    const rejected: unknown[] = [];
    Bus.observe((event, data) => {
      if (event.name === "engagement.transition_rejected") rejected.push(data);
    });
    EngagementStore.open(buildCreate(), "trace-open", T0);
    const outcome = move("eng-1", "done");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.code).toBe("illegal_transition");
    expect(EngagementStore.get("eng-1")?.revision).toBe(1);
    expect(Storage.get().ledger?.headFact("engagement:eng-1")?.seq).toBe(1);
    await flushBus();
    expect(rejected).toMatchObject([{ code: "illegal_transition", requested: "done" }]);
  });

  test("unknown engagement is a typed not_found", () => {
    let error: unknown;
    try {
      move("eng-missing", "deliberating");
    } catch (caught) {
      error = caught;
    }
    expect(Engagement.StoreError.isInstance(error)).toBe(true);
    expect((error as Engagement.StoreError).data.code).toBe("not_found");
  });

  test("acting from awaiting_user_approval demands the ownerApproved fact", () => {
    EngagementStore.open(buildCreate(), "trace-open", T0);
    move("eng-1", "deliberating");
    move("eng-1", "awaiting_user_approval");
    const denied = move("eng-1", "acting");
    expect(denied.kind).toBe("rejected");
    if (denied.kind !== "rejected") throw new Error("unreachable");
    expect(denied.code).toBe("approval_required");
    const approved = move("eng-1", "acting", { ownerApproved: true });
    expect(approved.kind).toBe("transitioned");
    expect(EngagementStore.get("eng-1")?.state).toBe("acting");
  });
});

describe("EngagementStore expiry", () => {
  test("expire lands the machine's own edge with its fact", () => {
    EngagementStore.open(buildCreate({ terms: { deadline: T0 + 500 } }), "trace-open", T0);
    const outcome = EngagementStore.expire("eng-1", "trace-expire", T0 + 1_000);
    expect(outcome.kind).toBe("expired");
    expect(EngagementStore.get("eng-1")?.state).toBe("expired");
    expect(Storage.get().ledger?.headFact("engagement:eng-1")?.type).toBe("engagement.expired");
  });

  test("listActive folds due deadlines lazily and excludes terminal records", () => {
    EngagementStore.open(buildCreate({ terms: { deadline: T0 + 500 } }), "trace-open", T0);
    EngagementStore.open(
      buildCreate({ id: "eng-2", title: "buy monitor, ceiling 200000", terms: {} }),
      "trace-open-2",
      T0,
    );
    const alive = EngagementStore.listActive("ses-owner", "trace-hydrate", T0 + 1_000);
    expect(alive.map((record) => record.id)).toEqual(["eng-2"]);
    expect(EngagementStore.get("eng-1")?.state).toBe("expired");
    // Idempotent: a second hydration sees the terminal row filtered by state.
    const again = EngagementStore.listActive("ses-owner", "trace-hydrate-2", T0 + 2_000);
    expect(again.map((record) => record.id)).toEqual(["eng-2"]);
  });

  test("listActive expires a record at the exact deadline instant (Deadline.isExpired boundary)", () => {
    EngagementStore.open(buildCreate({ terms: { deadline: T0 + 500 } }), "trace-open", T0);
    const atDeadline = EngagementStore.listActive("ses-owner", "trace-boundary", T0 + 500);
    expect(atDeadline).toEqual([]);
    expect(EngagementStore.get("eng-1")?.state).toBe("expired");
  });

  test("listActive treats a concurrent expiry winner as benign", () => {
    EngagementStore.open(buildCreate({ terms: { deadline: T0 + 500 } }), "trace-open", T0);
    const adapter = Storage.get().engagement;
    if (!adapter) throw new Error("engagement sub-adapter missing");
    adapter.compareAndSet = () => false;

    expect(EngagementStore.listActive("ses-owner", "trace-race", T0 + 1_000)).toEqual([]);
  });

  test("listActive propagates non-conflict expiry failures", () => {
    EngagementStore.open(buildCreate({ terms: { deadline: T0 + 500 } }), "trace-open", T0);
    const adapter = Storage.get().engagement;
    if (!adapter) throw new Error("engagement sub-adapter missing");
    adapter.compareAndSet = () => {
      throw new Error("projection unavailable");
    };

    expect(() => EngagementStore.listActive("ses-owner", "trace-failure", T0 + 1_000)).toThrow(
      "projection unavailable",
    );
  });

  test("listActive scopes to the owner session", () => {
    EngagementStore.open(buildCreate(), "trace-open", T0);
    EngagementStore.open(
      buildCreate({ id: "eng-other", ownerSessionId: "ses-other" }),
      "trace-open-2",
      T0,
    );
    expect(EngagementStore.listActive("ses-owner", "trace", T0).map((r) => r.id)).toEqual([
      "eng-1",
    ]);
  });
});

describe("EngagementStore fail-closed floor", () => {
  test("missing ledger append surface is a typed adapter_absent", () => {
    const configured = Storage.get();
    Object.defineProperty(configured, "ledger", { configurable: true, value: undefined });
    let error: unknown;
    try {
      EngagementStore.open(buildCreate(), "trace-open", T0);
    } catch (caught) {
      error = caught;
    }
    expect(Engagement.StoreError.isInstance(error)).toBe(true);
    expect((error as Engagement.StoreError).data.code).toBe("adapter_absent");
  });

  test("missing sub-adapter is a typed adapter_absent", () => {
    Storage.reset();
    Storage.configure({
      transaction: (operation) => operation(),
      session: { get: () => undefined, set: () => undefined, list: () => [], remove: () => false },
      message: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
      part: { get: () => undefined, set: () => undefined, list: () => [], remove: () => false },
    });
    let error: unknown;
    try {
      EngagementStore.open(buildCreate(), "trace-open", T0);
    } catch (caught) {
      error = caught;
    }
    expect(Engagement.StoreError.isInstance(error)).toBe(true);
    expect((error as Engagement.StoreError).data.code).toBe("adapter_absent");
  });
});
