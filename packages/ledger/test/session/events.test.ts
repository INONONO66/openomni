/// <reference types="bun" />

import { beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

/**
 * `Bus.publish` dispatches every subscriber in exactly one `queueMicrotask`
 * (`packages/telemetry/src/bus.ts:55-64`) with a synchronous handler body, and
 * the microtask queue drains completely before an awaiting continuation
 * resumes. One hop is therefore the exact completion signal for the publishes
 * already made, not a guess at scheduling latency.
 */
function flushBus(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("Session events carry the caller's trace (D11)", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("created and deleted inherit the input trace — no mint in the store", async () => {
    const created: string[] = [];
    const deleted: Array<{ traceId: string; id: string }> = [];
    const unsubCreated = Bus.subscribe(Session.Event.Created, (data) => {
      created.push(data.traceId);
    });
    const unsubDeleted = Bus.subscribe(Session.Event.Deleted, (data) => {
      deleted.push(data);
    });

    const session = Session.create({
      traceId: "trace-events-create",
      title: "Events",
      model: { providerID: "test", modelID: "test-model" },
    });
    const child = Session.createChild({
      traceId: "trace-events-child",
      parentSessionId: session.id,
      title: "Child",
      model: { providerID: "test", modelID: "test-model" },
    });
    Session.remove(child.id, "trace-events-remove");

    await flushBus();
    expect(created).toEqual(["trace-events-create", "trace-events-child"]);
    expect(deleted).toEqual([{ traceId: "trace-events-remove", id: child.id }]);
    unsubCreated();
    unsubDeleted();
  });

  test("schemas refuse an untraced payload", () => {
    // Enforcement is compile-time for typed producers; the schema states the
    // invariant so any future strict consumer refuses. Updated stays traceless
    // by design: it is ephemeral and never persists.
    const info = Session.create({
      traceId: "trace-events-schema",
      title: "Schema",
      model: { providerID: "test", modelID: "test-model" },
    });
    expect(Session.Event.Created.schema.safeParse({ info }).success).toBe(false);
    expect(Session.Event.Created.schema.safeParse({ traceId: "", info }).success).toBe(false);
    expect(Session.Event.Created.schema.safeParse({ traceId: "trace-1", info }).success).toBe(true);
    expect(Session.Event.Deleted.schema.safeParse({ id: info.id }).success).toBe(false);
    expect(Session.Event.Deleted.schema.safeParse({ traceId: "", id: info.id }).success).toBe(
      false,
    );
    expect(
      Session.Event.Deleted.schema.safeParse({ traceId: "trace-1", id: info.id }).success,
    ).toBe(true);
  });
});
