/// <reference types="bun" />

import { describe, expect, test, beforeEach } from "bun:test";
import { Session } from "../src/session";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../src/storage/storage";
import "../src/storage/initialize";

/** Bus delivery is microtask-queued; flush before asserting on received events. */
function flushBus(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Session TTL", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("create with ttlMs", () => {
    test("should create session without expiresAt when ttlMs not provided", () => {
      const session = Session.create({
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
      });

      expect(session.expiresAt).toBeUndefined();
    });

    test("should create session with expiresAt when ttlMs provided", () => {
      const ttlMs = 5000;
      const beforeCreate = Date.now();

      const session = Session.create({
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
      const stillStored = Storage.getAdapter().session.get(session.id);
      expect(stillStored).toBeDefined();
      await flushBus();
      expect(deleted).toEqual([]);
      unsub();
    });

    test("should return session without expiresAt normally", () => {
      const session = Session.create({
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
        title: "Session 1",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const session2 = Session.create({
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
        title: "Expired Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const activeSession = Session.create({
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
      expect(sessions[0].id).toBe(activeSession.id);

      // list() is a pure read: the expired row survives until the sweep.
      const stillStored = Storage.getAdapter().session.get(expiredSession.id);
      expect(stillStored).toBeDefined();
      await flushBus();
      expect(deleted).toEqual([]);
      unsub();
    });

    test("should handle mixed sessions correctly and stay stable across repeated reads", () => {
      const expired1 = Session.create({
        title: "Expired 1",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const active1 = Session.create({
        title: "Active 1",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      const noExpiry = Session.create({
        title: "No Expiry",
        model: { providerID: "test", modelID: "test-model" },
      });

      const expired2 = Session.create({
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
      expect(Storage.getAdapter().session.list().length).toBe(4);
    });
  });

  describe("sweepExpired", () => {
    test("removes expired sessions and leaves the rest untouched", async () => {
      const expired = Session.create({
        title: "Expired",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });
      const active = Session.create({
        title: "Active",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });
      const noExpiry = Session.create({
        title: "No Expiry",
        model: { providerID: "test", modelID: "test-model" },
      });

      const deleted: string[] = [];
      const unsub = Bus.subscribe(Session.Event.Deleted, (data) => {
        deleted.push(data.id);
      });

      const swept = Session.sweepExpired();

      expect(swept.map((s) => s.id)).toEqual([expired.id]);
      await flushBus();
      expect(deleted).toEqual([expired.id]);
      expect(Storage.getAdapter().session.get(expired.id)).toBeUndefined();
      expect(Storage.getAdapter().session.get(active.id)).toBeDefined();
      expect(Storage.getAdapter().session.get(noExpiry.id)).toBeDefined();
      unsub();
    });

    test("is a no-op when nothing is expired", () => {
      Session.create({
        title: "Active",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: 5000,
      });

      expect(Session.sweepExpired()).toEqual([]);
      expect(Storage.getAdapter().session.list().length).toBe(1);
    });
  });
});
