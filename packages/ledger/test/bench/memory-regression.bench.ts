import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { L0Observation } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { Bus } from "../helpers/observation";
import { materializeSession } from "../helpers/session";

function measureRSS(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

beforeEach(() => {
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("session memory regression", () => {
  test("canonical watch subscribe/unsubscribe releases listeners without deleting history", () => {
    materializeSession("watched");
    const baseline = measureRSS();
    for (let index = 0; index < 200; index += 1) {
      const watch = SessionHandleStore.watchSnapshot("watched", 1, Bus);
      watch.subscribe(() => undefined);
      watch.unsubscribe();
    }
    const growthMB = (measureRSS() - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(20);
    expect(SessionHandleStore.tree("watched")).toHaveLength(1);
  }, 30_000);

  test("bus subscribe/publish/unsubscribe does not leak", async () => {
    const baseline = measureRSS();
    for (let index = 0; index < 500; index += 1) {
      const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, () => undefined);
      for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
        Bus.publish(L0Observation.ActionCommittedEvent, {
          id: `${index}-${eventIndex}`,
          sessionId: "fanout",
          revision: 1,
          kind: "session.configure",
        });
      }
      unsubscribe();
    }
    // Publish dispatch is one queued microtask; drain that batch before measuring.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const growthMB = (measureRSS() - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(15);
  }, 30_000);

  test("idempotent canonical materialization does not accumulate rows or history", () => {
    const hydrate = () => {
      materializeSession("existing");
      SessionHandleStore.getSnapshot("existing");
    };
    // Warm the real parser/JIT path before measuring steady-state retention.
    // The measured batch and 15 MB bound are unchanged; no durable rows are cleared.
    for (let index = 0; index < 500; index += 1) hydrate();
    const baseline = measureRSS();
    for (let index = 0; index < 500; index += 1) hydrate();
    const growthMB = (measureRSS() - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(15);
    expect(SessionHandleStore.listRows()).toHaveLength(1);
    expect(SessionHandleStore.tree("existing")).toHaveLength(1);
  }, 30_000);
});
