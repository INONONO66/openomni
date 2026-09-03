/// <reference types="bun" />

import { describe, expect, test, beforeEach } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Session } from "../src/session";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../src/storage/storage";
import "../src/storage/initialize";

/**
 * `Bus.publish` queues every subscriber in exactly one `queueMicrotask`
 * (`packages/telemetry/src/bus.ts:55-64`), and the queue drains completely
 * before an awaiting continuation resumes. Every call under test here returns
 * synchronously, so anything it published is already queued when this runs:
 * one hop is the exact signal in both directions - it proves a delivery
 * arrived, and for the negative cases it proves the queue was drained past the
 * point where an unwanted delivery would have landed.
 */
function flushBus(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("Session TTL", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
  });

  describe("create with ttlMs", () => {
    test("should create session without expiresAt when ttlMs not provided", () => {
      const session = Session.create({
        traceId: "trace-ttl-test",
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
      });

      expect(session.expiresAt).toBeUndefined();
    });

    test("should create session with expiresAt when ttlMs provided", () => {
      const ttlMs = 5000;
      const beforeCreate = Date.now();

      const session = Session.create({
        traceId: "trace-ttl-test",
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs,
      });

      expect(session.expiresAt).toBeDefined();
      expect(session.expiresAt).toBeGreaterThanOrEqual(beforeCreate + ttlMs);
      expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + ttlMs + 100);
    });
  });

  describe("get with expiry", () => {
    test("should return session when not expired", () => {
      const session = Session.create({
        traceId: "trace-ttl-test",
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const retrieved = Session.get(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(session.id);
    });

    test("should return undefined for an expired session WITHOUT deleting it", async () => {
      // Reads are pure: expiry filtering never writes. Deletion is the
      // explicit sweep's job (sweepExpired below).
      const session = Session.create({
        traceId: "trace-ttl-test",
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const deleted: string[] = [];
      const unsub = Bus.subscribe(Session.Event.Deleted, (data) => {
        deleted.push(data.id);
      });

      const retrieved = Session.get(session.id);
      expect(retrieved).toBeUndefined();

      // The row survives the read; no delete event fired.
      const stillStored = Storage.get().session.get(session.id);
      expect(stillStored).toBeDefined();
      await flushBus();
      expect(deleted).toEqual([]);
      unsub();
    });

    test("should return session without expiresAt normally", () => {
      const session = Session.create({
        traceId: "trace-ttl-test",
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
      });

      const retrieved = Session.get(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(session.id);
    });
  });

  describe("list with expiry", () => {
    test("should include non-expired sessions", () => {
      const session1 = Session.create({
        traceId: "trace-ttl-test",
        title: "Session 1",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const session2 = Session.create({
        traceId: "trace-ttl-test",
        title: "Session 2",
        model: { providerID: "test", modelID: "test-model" },
      });

      const sessions = Session.list();
      expect(sessions.length).toBe(2);
      expect(sessions.find((s) => s.id === session1.id)).toBeDefined();
      expect(sessions.find((s) => s.id === session2.id)).toBeDefined();
    });

    test("should exclude expired sessions WITHOUT deleting them", async () => {
      const expiredSession = Session.create({
        traceId: "trace-ttl-test",
        title: "Expired Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const activeSession = Session.create({
        traceId: "trace-ttl-test",
        title: "Active Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const deleted: string[] = [];
      const unsub = Bus.subscribe(Session.Event.Deleted, (data) => {
        deleted.push(data.id);
      });

      const sessions = Session.list();
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.id).toBe(activeSession.id);

      // list() is a pure read: the expired row survives until the sweep.
      const stillStored = Storage.get().session.get(expiredSession.id);
      expect(stillStored).toBeDefined();
      await flushBus();
      expect(deleted).toEqual([]);
      unsub();
    });

    test("should handle mixed sessions correctly and stay stable across repeated reads", () => {
      const expired1 = Session.create({
        traceId: "trace-ttl-test",
        title: "Expired 1",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const active1 = Session.create({
        traceId: "trace-ttl-test",
        title: "Active 1",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const noExpiry = Session.create({
        traceId: "trace-ttl-test",
        title: "No Expiry",
        model: { providerID: "test", modelID: "test-model" },
      });

      const expired2 = Session.create({
        traceId: "trace-ttl-test",
        title: "Expired 2",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -2000,
      });

      // Interleaved reads during expiry must not corrupt each other: a get()
      // issued mid-listing (formerly a delete-while-iterating hazard) leaves
      // every row intact, and a second list() sees the identical view.
      const first = Session.list();
      Session.get(expired1.id);
      const second = Session.list();

      for (const sessions of [first, second]) {
        expect(sessions.length).toBe(2);
        expect(sessions.find((s) => s.id === active1.id)).toBeDefined();
        expect(sessions.find((s) => s.id === noExpiry.id)).toBeDefined();
        expect(sessions.find((s) => s.id === expired1.id)).toBeUndefined();
        expect(sessions.find((s) => s.id === expired2.id)).toBeUndefined();
      }
      expect(Storage.get().session.list().length).toBe(4);
    });
  });

  describe("sweepExpired", () => {
    test("removes expired sessions and leaves the rest untouched", async () => {
      const expired = Session.create({
        traceId: "trace-ttl-test",
        title: "Expired",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });
      const active = Session.create({
        traceId: "trace-ttl-test",
        title: "Active",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });
      const noExpiry = Session.create({
        traceId: "trace-ttl-test",
        title: "No Expiry",
        model: { providerID: "test", modelID: "test-model" },
      });

      const deleted: Array<{ traceId: string; id: string }> = [];
      const unsub = Bus.subscribe(Session.Event.Deleted, (data) => {
        deleted.push({ traceId: data.traceId, id: data.id });
      });

      const swept = Session.sweepExpired("trace-ttl-test");

      expect(swept.map((s) => s.id)).toEqual([expired.id]);
      await flushBus();
      expect(deleted).toEqual([{ traceId: "trace-ttl-test", id: expired.id }]);
      expect(Storage.get().session.get(expired.id)).toBeUndefined();
      expect(Storage.get().session.get(active.id)).toBeDefined();
      expect(Storage.get().session.get(noExpiry.id)).toBeDefined();
      unsub();
    });

    test("isolates one corrupt session: records Operational.Events.Error and keeps sweeping", async () => {
      const corrupt = Session.create({
        traceId: "trace-ttl-test",
        title: "Corrupt",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });
      const healthy = Session.create({
        traceId: "trace-ttl-test",
        title: "Healthy",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });
      const active = Session.create({
        traceId: "trace-ttl-test",
        title: "Active",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const errors: Array<{ component?: string; context?: Record<string, unknown> }> = [];
      const unsub = Bus.subscribe(Operational.Events.Error, (data) => {
        errors.push({ component: data.component, context: data.context });
      });

      // One row's removal fails (e.g. a corrupt cascade): the adapter's
      // session.remove throws only for that id.
      const adapter = Storage.get();
      const originalRemove = adapter.session.remove;
      Storage.configure({
        ...adapter,
        // Prototype methods do not survive the spread; delegate them.
        transaction: <T>(operation: () => T): T => adapter.transaction(operation),
        close: () => adapter.close?.(),
        session: {
          ...adapter.session,
          remove: (id: string) => {
            if (id === corrupt.id) throw new Error("corrupt session row");
            return originalRemove(id);
          },
        },
      });

      // One bad session never kills the sweep: the healthy expired session is
      // still removed and the corrupt one is recorded as an error.
      const swept = Session.sweepExpired("trace-ttl-test");

      expect(swept.map((s) => s.id)).toEqual([healthy.id]);
      expect(Storage.get().session.get(healthy.id)).toBeUndefined();
      expect(Storage.get().session.get(corrupt.id)).toBeDefined();
      expect(Storage.get().session.get(active.id)).toBeDefined();
      await flushBus();
      expect(errors).toEqual([
        { component: "session", context: expect.objectContaining({ sessionId: corrupt.id }) },
      ]);
      unsub();
    });

    test("is a no-op when nothing is expired", () => {
      Session.create({
        traceId: "trace-ttl-test",
        title: "Active",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      expect(Session.sweepExpired("trace-ttl-test")).toEqual([]);
      expect(Storage.get().session.list().length).toBe(1);
    });
  });
});
