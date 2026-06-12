import { afterEach, describe, expect, test } from "bun:test";

import { createSessionRouting, SessionRouting } from "../../src/worker-pool/session-routing";

describe("SessionRouting", () => {
  afterEach(() => {
    SessionRouting.clear();
  });

  test("same session always routes to same worker", () => {
    const id = "ses_same_affinity";
    const first = SessionRouting.route(id, 4);
    const second = SessionRouting.route(id, 4);
    expect(second).toBe(first);
    SessionRouting.complete(id);
    SessionRouting.complete(id);
  });

  test("keeps same-session affinity until all concurrent routes complete", () => {
    const ts = Date.now();
    const preload = `ses_concurrent_preload_${ts}`;
    const id = `ses_concurrent_${ts}`;
    const blocker = `ses_concurrent_block_${ts}`;

    const preloaded = SessionRouting.route(preload, 2);
    const first = SessionRouting.route(id, 2);
    const second = SessionRouting.route(id, 2);
    expect(first).not.toBe(preloaded);
    expect(second).toBe(first);

    SessionRouting.complete(id);

    SessionRouting.route(blocker, 2);

    expect(SessionRouting.route(id, 2)).toBe(first);

    SessionRouting.complete(id);
    SessionRouting.complete(id);
    SessionRouting.complete(preload);
    SessionRouting.complete(blocker);

    const reassigned = SessionRouting.route(id, 2);
    expect(reassigned).not.toBe(first);

    SessionRouting.complete(id);
  });

  test("different sessions can route to different workers", () => {
    const ids = ["ses_a", "ses_b", "ses_c", "ses_d"];
    const indices = ids.map((id) => SessionRouting.route(id, 4));
    expect(new Set(indices).size).toBe(4);
    for (const id of ids) SessionRouting.complete(id);
  });

  test("complete() decrements load", () => {
    const ts = Date.now();
    const a = `ses_fill_a_${ts}`;
    const b = `ses_fill_b_${ts}`;
    const id = `ses_load_decrement_${ts}`;

    const idxA = SessionRouting.route(a, 2);
    const idxB = SessionRouting.route(b, 2);
    expect(idxA).not.toBe(idxB);

    SessionRouting.complete(a);

    const idx = SessionRouting.route(id, 2);
    expect(idx).toBe(idxA);

    SessionRouting.complete(b);
    SessionRouting.complete(id);
  });

  test("after complete(), session can be reassigned to a different worker", () => {
    const id = "ses_reassign";
    const workerCount = 2;

    const first = SessionRouting.route(id, workerCount);
    SessionRouting.complete(id);

    const blockers = ["ses_block1", "ses_block2", "ses_block3"];
    for (const blocker of blockers) {
      SessionRouting.route(blocker, workerCount);
    }

    const second = SessionRouting.route(id, workerCount);
    expect(second).not.toBe(first);

    SessionRouting.complete(id);
    for (const blocker of blockers) {
      SessionRouting.complete(blocker);
    }
  });

  test("createSessionRouting() returns isolated affinity state for production consumers", () => {
    const first = createSessionRouting();
    const second = createSessionRouting();

    first.assign("session-a", 7);
    expect(first.get("session-a")).toBe(7);
    expect(second.get("session-a")).toBeUndefined();

    first.assign("session-b", 7);
    first.forgetWorker(7);

    expect(first.get("session-a")).toBeUndefined();
    expect(first.get("session-b")).toBeUndefined();
  });

  test("assign() preserves outstanding route references when moving affinity", () => {
    const routing = createSessionRouting();

    const first = routing.route("session-move", 2);
    routing.route("session-move", 2);
    const next = first === 0 ? 1 : 0;

    routing.assign("session-move", next);
    expect(routing.get("session-move")).toBe(next);

    routing.complete("session-move");
    expect(routing.get("session-move")).toBe(next);

    routing.complete("session-move");
    expect(routing.get("session-move")).toBeUndefined();
  });

  test("assign() is idempotent for the same session and worker", () => {
    const routing = createSessionRouting();

    routing.assign("session-stable", 1);
    routing.assign("session-stable", 1);
    expect(routing.get("session-stable")).toBe(1);

    routing.complete("session-stable");
    expect(routing.get("session-stable")).toBeUndefined();
  });
});
