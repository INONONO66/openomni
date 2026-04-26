import { describe, expect, test, beforeEach } from "bun:test";
import { Session } from "../src/session";
import { Storage } from "../src/storage/storage";
import "../src/storage/initialize";

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

    test("should return undefined and remove session when expired", () => {
      const session = Session.create({
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const retrieved = Session.get(session.id);
      expect(retrieved).toBeUndefined();

      const checkAgain = Session.storage.get(session.id);
      expect(checkAgain).toBeUndefined();
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

    test("should exclude expired sessions and remove them", () => {
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

      const sessions = Session.list();
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe(activeSession.id);

      const checkExpired = Session.storage.get(expiredSession.id);
      expect(checkExpired).toBeUndefined();
    });

    test("should handle mixed sessions correctly", () => {
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

      const sessions = Session.list();
      expect(sessions.length).toBe(2);
      expect(sessions.find((s) => s.id === active1.id)).toBeDefined();
      expect(sessions.find((s) => s.id === noExpiry.id)).toBeDefined();
      expect(sessions.find((s) => s.id === expired1.id)).toBeUndefined();
      expect(sessions.find((s) => s.id === expired2.id)).toBeUndefined();
    });
  });

  describe("lazy deletion", () => {
    test("should not auto-delete expired sessions until accessed", () => {
      const session = Session.create({
        title: "Test Session",
        model: { providerID: "test", modelID: "test-model" },
        ttlMs: -1000,
      });

      const directCheck = Session.storage.get(session.id);
      expect(directCheck).toBeDefined();

      Session.get(session.id);

      const afterGet = Session.storage.get(session.id);
      expect(afterGet).toBeUndefined();
    });
  });
});
