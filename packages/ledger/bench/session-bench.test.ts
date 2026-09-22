import { Effect, Either } from "effect";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { SessionHandleStore, Storage } from "../src/index";
import { prepareTurnCommit, seedTurnHistory } from "./seed-turn-history";

const Metric = z.object({
  name: z.string(),
  unit: z.literal("ns/op"),
  value: z.number().positive(),
});

describe("session benchmark fixtures", () => {
  afterEach(() => Storage.reset());

  test("default seed preserves ten complete turns", () => {
    Storage.initialize({ dbPath: ":memory:" });
    seedTurnHistory("default");
    const snapshot = SessionHandleStore.getSnapshot("default", 10);
    expect(snapshot.turns).toHaveLength(10);
    expect(SessionHandleStore.tree("default")).toHaveLength(21);
  });

  test.each([500, 5_000])("%i turns seed exactly twice as many committed turn actions", (count) => {
    Storage.initialize({ dbPath: ":memory:" });
    const id = `seed-${count}`;
    seedTurnHistory(id, count);
    const tree = SessionHandleStore.tree(id);
    expect(tree).toHaveLength(count * 2 + 1);
    expect(tree.filter((action) => action.kind === "turn")).toHaveLength(count * 2);
    expect(SessionHandleStore.row(id).revision).toBe(tree.length);
    for (let index = 1; index < tree.length; index += 1) {
      expect(tree[index]?.parentId).toBe(tree[index - 1]?.id);
    }
    const page = SessionHandleStore.historyPage(id, { limit: 50 });
    expect(page.actions).toEqual(tree.slice(0, 50));
    expect(page.headRevision).toBe(tree.length);
    expect(page.nextRevision).toBe(50);
  });

  test("preparing a warm-session commit leaves history unchanged until one action is committed", () => {
    Storage.initialize({ dbPath: ":memory:" });
    seedTurnHistory("warm");
    const tree = SessionHandleStore.tree("warm");
    const request = prepareTurnCommit(
      "warm",
      10,
      tree.at(-1)?.id ?? null,
      SessionHandleStore.latestGeneration(tree),
    );
    request.actions = request.actions.slice(0, 1);
    expect(SessionHandleStore.tree("warm")).toEqual(tree);
    const result = Either.getOrThrowWith(Effect.runSync(Effect.either(SessionHandleStore.commit(request))), (error) => error);
    expect(result).toMatchObject({ ok: true, row: { revision: 22, leaseOwner: null } });
    expect(SessionHandleStore.tree("warm").at(-1)).toMatchObject({
      id: "warm:turn:10",
      kind: "turn",
      parentId: tree.at(-1)?.id,
    });
    expect(SessionHandleStore.tree("warm")).toHaveLength(22);
  });
});

// The whole benchmark runs in-process with a 10 ms sampling budget per phase; what
// remains is seeding 10k actions and walking them, which the exact collector's
// instrumentation runs about five times slower than the plain lane.
test("benchmark entry point emits the ten existing ledger metrics and four new session metrics", async () => {
  const commit = SessionHandleStore.commit;
  const widths: number[] = [];
  const tracked = spyOn(SessionHandleStore, "commit").mockImplementation((request) => {
    if (request.sessionId === "commit-session") widths.push(request.actions.length);
    return commit(request);
  });
  process.env.BENCHMARK_BUDGET_MS = "10";
  try {
    await import("./index");
  } finally {
    delete process.env.BENCHMARK_BUDGET_MS;
    tracked.mockRestore();
  }
  expect(widths.length).toBeGreaterThan(10);
  expect(widths.slice(10).every((width) => width === 1)).toBe(true);
  const metrics = Metric.array().parse(await Bun.file("bench-results/session.json").json());
  expect(metrics.map((metric) => metric.name).sort()).toEqual([
    "bus-fanout/10-subscribers",
    "bus-fanout/100-subscribers",
    "bus-fanout/50-subscribers",
    "message-serialization/parse-message",
    "message-serialization/stringify-message",
    "session-commit/action",
    "session-history/page",
    "session-hydration/get-messages",
    "session-hydration/get-session",
    "session-tree/10k-actions",
    "session-tree/1k-actions",
    "storage-session-list/10-sessions",
    "storage-session-list/100-sessions",
    "storage-session-list/500-sessions",
  ]);
}, 120_000);
