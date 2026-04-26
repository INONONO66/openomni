import { describe, it, expect, beforeEach } from "bun:test";
import { Session, Storage } from "@openomni/session";
import type { Message } from "../../src/session/message";

describe("Session", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("create", () => {
    it("should create a new session with generated ID", () => {
      const session = Session.create({
        title: "Test Session",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      expect(session.id).toBeDefined();
      expect(session.title).toBe("Test Session");
      expect(session.model.providerID).toBe("openai");
      expect(session.model.modelID).toBe("gpt-4");
      expect(session.time.created).toBeDefined();
      expect(session.time.updated).toBeDefined();
    });

    it("should generate unique IDs for multiple sessions", () => {
      const session1 = Session.create({
        title: "Session 1",
        model: { providerID: "openai", modelID: "gpt-4" },
      });
      const session2 = Session.create({
        title: "Session 2",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      expect(session1.id).not.toBe(session2.id);
    });

    it("should set created and updated timestamps to current time", () => {
      const before = Date.now();
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });
      const after = Date.now();

      expect(session.time.created).toBeGreaterThanOrEqual(before);
      expect(session.time.created).toBeLessThanOrEqual(after);
      expect(session.time.updated).toBe(session.time.created);
    });
  });

  describe("get", () => {
    it("should retrieve a session by ID", () => {
      const created = Session.create({
        title: "Test Session",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const retrieved = Session.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe("Test Session");
    });

    it("should return undefined for non-existent session", () => {
      const retrieved = Session.get("non-existent-id");
      expect(retrieved).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should return empty array when no sessions exist", () => {
      const sessions = Session.list();
      expect(sessions).toEqual([]);
    });

    it("should return all created sessions", () => {
      const session1 = Session.create({
        title: "Session 1",
        model: { providerID: "openai", modelID: "gpt-4" },
      });
      const session2 = Session.create({
        title: "Session 2",
        model: { providerID: "anthropic", modelID: "claude-3" },
      });

      const sessions = Session.list();

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id)).toContain(session1.id);
      expect(sessions.map((s) => s.id)).toContain(session2.id);
    });
  });

  describe("update", () => {
    it("should update session title", () => {
      const created = Session.create({
        title: "Original Title",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const updated = Session.update(created.id, { title: "Updated Title" });

      expect(updated?.title).toBe("Updated Title");
      expect(updated?.id).toBe(created.id);
    });

    it("should update session model", () => {
      const created = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const updated = Session.update(created.id, {
        model: { providerID: "anthropic", modelID: "claude-3" },
      });

      expect(updated?.model.providerID).toBe("anthropic");
      expect(updated?.model.modelID).toBe("claude-3");
    });

    it("should automatically update time.updated", async () => {
      const created = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const originalUpdated = created.time.updated;

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = Session.update(created.id, { title: "New Title" });

      expect(updated?.time.updated).toBeGreaterThan(originalUpdated);
    });

    it("should return undefined for non-existent session", () => {
      const updated = Session.update("non-existent-id", { title: "New Title" });
      expect(updated).toBeUndefined();
    });

    it("should preserve other fields when updating partial data", () => {
      const created = Session.create({
        title: "Original",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const updated = Session.update(created.id, { title: "Updated" });

      expect(updated?.model.providerID).toBe("openai");
      expect(updated?.model.modelID).toBe("gpt-4");
    });
  });

  describe("remove", () => {
    it("should remove a session", () => {
      const created = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const removed = Session.remove(created.id);

      expect(removed).toBe(true);
      expect(Session.get(created.id)).toBeUndefined();
    });

    it("should return false for non-existent session", () => {
      const removed = Session.remove("non-existent-id");
      expect(removed).toBe(false);
    });

    it("should also remove associated messages", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const message: Message.UserMessage = {
        id: "msg-1",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test-agent",
        model: { providerID: "openai", modelID: "gpt-4" },
      };

      Session.addMessage(session.id, message);
      expect(Session.getMessages(session.id)).toHaveLength(1);

      Session.remove(session.id);

      expect(Session.getMessages(session.id)).toHaveLength(0);
    });
  });

  describe("addMessage", () => {
    it("should add a message to a session", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const message: Message.UserMessage = {
        id: "msg-1",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test-agent",
        model: { providerID: "openai", modelID: "gpt-4" },
      };

      Session.addMessage(session.id, message);

      const messages = Session.getMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-1");
    });

    it("should add multiple messages to a session", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const message1: Message.UserMessage = {
        id: "msg-1",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test-agent",
        model: { providerID: "openai", modelID: "gpt-4" },
      };

      const message2: Message.AssistantMessage = {
        id: "msg-2",
        sessionID: session.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "msg-1",
        modelID: "gpt-4",
        providerID: "openai",
        agent: "test-agent",
        path: { cwd: "/test", root: "/test" },
        cost: 0.001,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };

      Session.addMessage(session.id, message1);
      Session.addMessage(session.id, message2);

      const messages = Session.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[1].id).toBe("msg-2");
    });

    it("should preserve message order", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const ids = ["msg-1", "msg-2", "msg-3"];

      for (const id of ids) {
        const message: Message.UserMessage = {
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "test-agent",
          model: { providerID: "openai", modelID: "gpt-4" },
        };
        Session.addMessage(session.id, message);
      }

      const messages = Session.getMessages(session.id);
      expect(messages.map((m) => m.id)).toEqual(ids);
    });
  });

  describe("getMessages", () => {
    it("should return empty array for session with no messages", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const messages = Session.getMessages(session.id);
      expect(messages).toEqual([]);
    });

    it("should return empty array for non-existent session", () => {
      const messages = Session.getMessages("non-existent-id");
      expect(messages).toEqual([]);
    });

    it("should return messages in order they were added", () => {
      const session = Session.create({
        title: "Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const message1: Message.UserMessage = {
        id: "msg-1",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test-agent",
        model: { providerID: "openai", modelID: "gpt-4" },
      };

      const message2: Message.UserMessage = {
        id: "msg-2",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test-agent",
        model: { providerID: "openai", modelID: "gpt-4" },
      };

      Session.addMessage(session.id, message1);
      Session.addMessage(session.id, message2);

      const messages = Session.getMessages(session.id);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[1].id).toBe("msg-2");
    });
  });

  describe("Integration", () => {
    it("should handle complete session lifecycle", () => {
      const session = Session.create({
        title: "Integration Test",
        model: { providerID: "openai", modelID: "gpt-4" },
      });

      const userMsg: Message.UserMessage = {
        id: "msg-1",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test-agent",
        model: { providerID: "openai", modelID: "gpt-4" },
      };

      Session.addMessage(session.id, userMsg);

      const updated = Session.update(session.id, {
        title: "Updated Integration Test",
      });

      expect(updated?.title).toBe("Updated Integration Test");
      expect(Session.getMessages(session.id)).toHaveLength(1);

      const allSessions = Session.list();
      expect(allSessions).toHaveLength(1);

      Session.remove(session.id);
      expect(Session.get(session.id)).toBeUndefined();
      expect(Session.getMessages(session.id)).toHaveLength(0);
    });
  });
});
