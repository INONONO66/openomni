import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { Session, Storage } from "../../src/index";

/**
 * Characterization of `Session.materialize` (slop-audit duplication #6
 * `session/lifecycle.ts:31-42 <-> :90-100` — create and materialize build,
 * store, and publish the same root-session row). `materialize` had NO test of
 * its own, so this file pins its observable behavior before the duplicated
 * row-construction collapses into one owner:
 *
 *   - it is the create-if-absent path for a gateway-minted session id
 *     (#707 stage 2): idempotent, so a re-delivery after a crash between the
 *     surface claim and Deliver converges instead of duplicating;
 *   - the FIRST call builds a root row (spawnDepth 0, created === updated),
 *     stores it, publishes session.created, and reports created: true;
 *   - a REPEAT call returns the stored row untouched, publishes nothing, and
 *     reports created: false — including when the stored row has since been
 *     updated;
 *   - ttlMs seeds expiresAt exactly as create does.
 */

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

const model = { providerID: "test", modelID: "test-model" };

function observeSessionEvents() {
  const seen: Array<{ name: string; id: unknown }> = [];
  Bus.observe((event, data) => {
    if (event.name.startsWith("session.")) {
      seen.push({ name: event.name, id: (data as { info?: { id?: string } }).info?.id });
    }
  });
  return seen;
}

describe("Session.materialize", () => {
  test("first call builds the gateway-minted root row and publishes created", async () => {
    const seen = observeSessionEvents();

    const { session, created } = Session.materialize({
      id: "ses-minted-1",
      traceId: "trace-deliver",
      title: "inbound turn",
      model,
    });

    expect(created).toBe(true);
    expect(session.id).toBe("ses-minted-1");
    expect(session.title).toBe("inbound turn");
    expect(session.model).toEqual(model);
    // A materialized row is a ROOT session: no parent, depth 0.
    expect(session.spawnDepth).toBe(0);
    expect(session.parentSessionId).toBeUndefined();
    // created === updated on a freshly built row (same clock read).
    expect(session.time.created).toBe(session.time.updated);
    // No TTL requested means no expiry field at all, not a null/0 sentinel.
    expect("expiresAt" in session).toBe(false);

    // The row is durable immediately, before any subscriber ran.
    expect(Session.get("ses-minted-1")).toEqual(session);

    await flushBus();
    expect(seen).toEqual([{ name: "session.created", id: "ses-minted-1" }]);
  });

  test("the caller's id is honored verbatim — materialize never mints one", () => {
    const { session } = Session.materialize({
      id: "ses-exact-id",
      traceId: "t",
      title: "x",
      model,
    });
    expect(session.id).toBe("ses-exact-id");
  });

  test("ttlMs seeds expiresAt from the same clock read as created", () => {
    const { session } = Session.materialize({
      id: "ses-ttl",
      traceId: "t",
      title: "x",
      model,
      ttlMs: 60_000,
    });
    expect(session.expiresAt).toBe(session.time.created + 60_000);
  });

  test("a repeat call is idempotent: same row, created false, no second event", async () => {
    const first = Session.materialize({ id: "ses-idem", traceId: "t1", title: "first", model });
    const seen = observeSessionEvents();

    const second = Session.materialize({
      id: "ses-idem",
      traceId: "t2",
      // A re-delivery may carry a different title; the stored row wins.
      title: "second attempt",
      model: { providerID: "other", modelID: "other-model" },
      ttlMs: 5_000,
    });

    expect(second.created).toBe(false);
    expect(second.session).toEqual(first.session);
    expect(second.session.title).toBe("first");
    expect(second.session.model).toEqual(model);
    expect("expiresAt" in second.session).toBe(false);

    await flushBus();
    expect(seen).toEqual([]);
  });

  test("a repeat call after an update returns the UPDATED row, not a rebuilt one", async () => {
    Session.materialize({ id: "ses-updated", traceId: "t1", title: "before", model });
    Session.update("ses-updated", { title: "after" });
    const seen = observeSessionEvents();

    const { session, created } = Session.materialize({
      id: "ses-updated",
      traceId: "t2",
      title: "before",
      model,
    });
    expect(created).toBe(false);
    expect(session.title).toBe("after");

    await flushBus();
    expect(seen).toEqual([]);
  });

  test("materialize and create agree on the root row shape they build", () => {
    const created = Session.create({ traceId: "t", title: "same title", model, ttlMs: 1_000 });
    const materialized = Session.materialize({
      id: "ses-parity",
      traceId: "t",
      title: "same title",
      model,
      ttlMs: 1_000,
    }).session;

    // Everything except the id (create mints, materialize is told) and the
    // clock read must match — this is the duplication being consolidated.
    const shapeOf = (session: typeof created) => ({
      title: session.title,
      model: session.model,
      spawnDepth: session.spawnDepth,
      hasParent: session.parentSessionId !== undefined,
      ttlOffset: (session.expiresAt ?? 0) - session.time.created,
      createdEqualsUpdated: session.time.created === session.time.updated,
      keys: Object.keys(session).sort(),
    });
    expect(shapeOf(materialized)).toEqual(shapeOf(created));
  });

  test("an expired stored row is invisible, so materialize rebuilds it", async () => {
    const { session } = Session.materialize({
      id: "ses-expired",
      traceId: "t1",
      title: "old",
      model,
      ttlMs: 1,
    });
    // Reads are pure: an expired row is filtered out of get() without being
    // deleted, so the create-if-absent probe sees "absent" and rebuilds.
    Session.update("ses-expired", { expiresAt: session.time.created - 1 });
    expect(Session.get("ses-expired")).toBeUndefined();

    const seen = observeSessionEvents();
    const again = Session.materialize({
      id: "ses-expired",
      traceId: "t2",
      title: "new",
      model,
    });
    expect(again.created).toBe(true);
    expect(again.session.title).toBe("new");

    await flushBus();
    expect(seen).toEqual([{ name: "session.created", id: "ses-expired" }]);
  });
});
