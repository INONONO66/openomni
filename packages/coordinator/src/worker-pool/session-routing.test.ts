import { describe, expect, test } from "bun:test";
import { sessionRouting } from "./session-routing.js";

describe("sessionRouting", () => {
  test("same session always routes to same worker", () => {
    const id = "ses_same_affinity";
    const first = sessionRouting.route(id, 4);
    const second = sessionRouting.route(id, 4);
    expect(second).toBe(first);
    sessionRouting.complete(id);
  });

  test("different sessions can route to different workers", () => {
    const ids = ["ses_a", "ses_b", "ses_c", "ses_d"];
    const indices = ids.map((id) => sessionRouting.route(id, 4));
    expect(new Set(indices).size).toBe(4);
    for (const id of ids) sessionRouting.complete(id);
  });

  test("complete() decrements load", () => {
    const a = "ses_fill_a";
    const b = "ses_fill_b";
    const id = "ses_load_decrement";

    sessionRouting.route(a, 2);
    sessionRouting.route(b, 2);
    sessionRouting.complete(a);

    const idx = sessionRouting.route(id, 2);
    expect(idx).toBe(0);

    sessionRouting.complete(b);
    sessionRouting.complete(id);
  });

  test("after complete(), session can be reassigned to a different worker", () => {
    const id = "ses_reassign";
    const workerCount = 2;

    const first = sessionRouting.route(id, workerCount);
    sessionRouting.complete(id);

    // Three blockers: first two fill workers 0 and 1 (load 1:1),
    // third goes to worker 0 (tie-break), leaving load 2:1.
    // `id` then re-evaluates onto worker 1 (min-load), != first (0).
    const blockers = ["ses_block1", "ses_block2", "ses_block3"];
    for (const b of blockers) sessionRouting.route(b, workerCount);

    const second = sessionRouting.route(id, workerCount);
    expect(second).not.toBe(first);

    sessionRouting.complete(id);
    for (const b of blockers) sessionRouting.complete(b);
  });
});
