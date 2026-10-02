import { sessionTree } from "../test/store/helpers/session-tree";
import { rmSync } from "node:fs";
import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runLedgerSync } from "../test/store/helpers/effect";
import { useMemoryStores } from "../test/store/helpers/storage";
import { prepareTurnCommit, seedTurnHistory } from "./seed-turn-history";

const Metric = z.object({
  name: z.string(),
  unit: z.literal("ns/op"),
  value: z.number().positive(),
});

describe("session benchmark fixtures", () => {
  const stores = useMemoryStores();

  test("default seed preserves ten complete turns", () => {
    seedTurnHistory(stores.kernel, "default");
    const snapshot = stores.kernel.getSnapshot("default", 10);
    expect(snapshot.turns).toHaveLength(10);
    expect(sessionTree("default", stores.session.actions)).toHaveLength(21);
  });

  test.each([500, 5_000])("%i turns seed exactly twice as many committed turn actions", (count) => {
    const id = `seed-${count}`;
    seedTurnHistory(stores.kernel, id, count);
    const tree = sessionTree(id, stores.session.actions);
    expect(tree).toHaveLength(count * 2 + 1);
    expect(tree.filter((action) => action.kind === "turn")).toHaveLength(count * 2);
    expect(stores.kernel.row(id).revision).toBe(tree.length);
    for (let index = 1; index < tree.length; index += 1) {
      expect(tree[index]?.parentId).toBe(tree[index - 1]?.id);
    }
    const page = stores.kernel.historyPage(id, { limit: 50 });
    expect(page.actions).toEqual(tree.slice(0, 50));
    expect(page.headRevision).toBe(tree.length);
    expect(page.nextRevision).toBe(50);
  });

  test("preparing a warm-session commit leaves history unchanged until one action is committed", () => {
    seedTurnHistory(stores.kernel, "warm");
    const tree = sessionTree("warm", stores.session.actions);
    const request = prepareTurnCommit(
      stores.kernel,
      "warm",
      10,
      tree.at(-1)?.id ?? null,
      stores.kernel.latestGenerationFor("warm"),
    );
    request.actions = request.actions.slice(0, 1);
    expect(sessionTree("warm", stores.session.actions)).toEqual(tree);
    const result = Result.getOrThrowWith(
      runLedgerSync(Effect.result(stores.kernel.commit(request))),
      (error) => error,
    );
    expect(result).toMatchObject({ ok: true, row: { revision: 22, fenceOwner: "bench" } });
    expect(sessionTree("warm", stores.session.actions).at(-1)).toMatchObject({
      id: "warm:turn:10",
      kind: "turn",
      parentId: tree.at(-1)?.id,
    });
    expect(sessionTree("warm", stores.session.actions)).toHaveLength(22);
  });
});

// The whole benchmark runs in-process with a 10 ms sampling budget per phase; what
// remains is seeding 10k actions and walking them, which the exact collector's
// instrumentation runs about five times slower than the plain lane.
test("benchmark entry point emits the ten existing ledger metrics and four new session metrics", async () => {
  rmSync("bench-results/session.json", { force: true });
  process.env.BENCHMARK_BUDGET_MS = "10";
  try {
    await import("./store");
  } finally {
    delete process.env.BENCHMARK_BUDGET_MS;
  }
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
