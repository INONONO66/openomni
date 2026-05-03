import { beforeEach, describe, expect, it } from "bun:test";
import type { ExecutionEvent, Message, Plan } from "@openomni/protocol";
import { EventLog, Session, Storage } from "@openomni/session";
import { SessionBridge } from "../../src/ingress/session-bridge";

const TEST_MODEL = { provider: "anthropic", id: "claude-3-haiku" };

function createTestSession(): string {
  return Session.create({
    title: "Test Session",
    model: { providerID: "anthropic", modelID: "claude-3-haiku" },
  }).id;
}

function addUserMessage(sessionId: string, text: string): void {
  const message: Message.UserMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "anthropic", modelID: "claude-3-haiku" },
  };
  Session.addMessage(sessionId, message);

  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  };
  Session.addPart(message.id, part);
}

function addAssistantMessage(sessionId: string, text: string): void {
  const message: Message.AssistantMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-3-haiku",
    providerID: "anthropic",
    agent: "test",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  Session.addMessage(sessionId, message);

  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  };
  Session.addPart(message.id, part);
}

function createTestPlan(): Plan {
  return {
    planId: "plan-1",
    goal: "Build an API",
    steps: [
      {
        stepId: "s1",
        description: "Design routes",
        expectedOutput: "Route map",
        dependsOn: [],
      },
      {
        stepId: "s2",
        description: "Implement handlers",
        expectedOutput: "Working endpoints",
        dependsOn: ["s1"],
      },
    ],
    createdAt: new Date("2025-01-15T10:00:00Z"),
    version: 1,
  };
}

async function replayEvents(sessionId: string): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of EventLog.replay(sessionId)) events.push(event);
  return events;
}

function expectBusEvent(event: ExecutionEvent, name: string): ExecutionEvent.MirroredBusEvent {
  expect(event.type).toBe("bus_event");
  if (event.type !== "bus_event") throw new Error(`Expected bus_event, got ${event.type}`);
  expect(event.name).toBe(name);
  return event;
}

function findBusEvent(events: ExecutionEvent[], name: string): ExecutionEvent.MirroredBusEvent {
  const event = events.find((row) => row.type === "bus_event" && row.name === name);
  if (!event) throw new Error(`Missing bus_event: ${name}`);
  return expectBusEvent(event, name);
}

function filterBusEvents(
  events: ExecutionEvent[],
  prefix: string,
): ExecutionEvent.MirroredBusEvent[] {
  return events.filter(
    (row): row is ExecutionEvent.MirroredBusEvent =>
      row.type === "bus_event" && row.name.startsWith(prefix),
  );
}

function expectPayload(event: ExecutionEvent.MirroredBusEvent): Record<string, unknown> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw new Error("Expected object payload");
  }
  return Object.fromEntries(Object.entries(event.payload));
}

async function expectNoPlan(sessionId: string): Promise<void> {
  try {
    await SessionBridge.extractPlan(sessionId);
    throw new Error("Expected extractPlan to reject");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/No plan found in session/);
  }
}

describe("SessionBridge", () => {
  let sessionId: string;

  function getPlanAdapter() {
    const adapter = Storage.get().plan;
    if (!adapter) throw new Error("Plan storage adapter is required for tests");
    return adapter;
  }

  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    sessionId = createTestSession();
  });

  describe("storePlanResult + extractPlan round-trip", () => {
    it("should store and extract Plan with createdAt as Date", async () => {
      const plan = createTestPlan();
      getPlanAdapter().write(plan.planId, JSON.stringify(plan));
      const planResult: Plan.Result = { planId: plan.planId };

      SessionBridge.storePlanResult(sessionId, planResult, TEST_MODEL);

      const extracted = await SessionBridge.extractPlan(sessionId);

      expect(extracted.planId).toBe(plan.planId);
      expect(extracted.goal).toBe(plan.goal);
      expect(extracted.steps).toHaveLength(2);
      expect(extracted.steps[0].stepId).toBe("s1");
      expect(extracted.steps[1].dependsOn).toEqual(["s1"]);
      expect(extracted.createdAt).toBeInstanceOf(Date);
      expect(extracted.createdAt.toISOString()).toBe(plan.createdAt.toISOString());
      expect(extracted.version).toBe(1);
    });

    it("should write linked EventLog envelopes for plan result writeback", async () => {
      const plan = createTestPlan();
      getPlanAdapter().write(plan.planId, JSON.stringify(plan));

      SessionBridge.storePlanResult(sessionId, { planId: plan.planId }, TEST_MODEL);

      const messages = Session.getMessages(sessionId);
      const message = messages[0] as Message.AssistantMessage;
      const part = Session.getParts(message.id)[0] as Message.TextPart;
      const events = await replayEvents(sessionId);

      expect(events).toHaveLength(5);
      expect(events.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events.every((row) => row.visibility === "internal")).toBe(true);

      const writebackEvents = filterBusEvents(events, "ingress.writeback.");
      expect(writebackEvents.map((row) => row.name)).toEqual([
        "ingress.writeback.plan_result",
        "ingress.writeback.message.write",
        "ingress.writeback.part.write",
      ]);

      const writeback = expectBusEvent(writebackEvents[0], "ingress.writeback.plan_result");
      const messageWrite = expectBusEvent(writebackEvents[1], "ingress.writeback.message.write");
      const partWrite = expectBusEvent(writebackEvents[2], "ingress.writeback.part.write");
      expect(messageWrite.parentActionId).toBe(writeback.actionId);
      expect(partWrite.parentActionId).toBe(messageWrite.actionId);

      const sessionMessage = findBusEvent(events, "session.message.added");
      const sessionPart = findBusEvent(events, "session.part.added");
      expect(sessionPart.parentActionId).toBe(sessionMessage.actionId);
      expect(expectPayload(sessionMessage)).toMatchObject({
        sessionId,
        messageId: message.id,
        role: "assistant",
        status: "completed",
        providerId: "anthropic",
        modelId: "claude-3-haiku",
      });
      expect(expectPayload(sessionPart)).toMatchObject({
        sessionId,
        messageId: message.id,
        partMessageId: message.id,
        partId: part.id,
        partType: "text",
      });
      expect(expectPayload(writeback)).toMatchObject({
        sessionId,
        mode: "plan",
        source: "session-bridge",
        messageId: message.id,
        partId: part.id,
        role: "assistant",
        planId: plan.planId,
        marker: "__OPENOMNI_PLANID__",
      });
      expect(part.text).toBe(`__OPENOMNI_PLANID__${plan.planId}`);
    });
  });

  describe("extractPlan", () => {
    it("should throw Error with 'No plan' when session is empty", async () => {
      await expectNoPlan(sessionId);
    });

    it("should throw Error with 'No plan' when session has only user messages", async () => {
      addUserMessage(sessionId, "Hello");
      addUserMessage(sessionId, "Build me something");

      await expectNoPlan(sessionId);
    });

    it("should ignore plan marker in user messages (spoofing prevention)", async () => {
      addUserMessage(sessionId, "__OPENOMNI_PLANID__fake-plan-id");

      await expectNoPlan(sessionId);
    });
  });

  describe("buildPlanGoal", () => {
    it("should return latest user message text when no plan exists", async () => {
      addUserMessage(sessionId, "Build me an API gateway");

      const goal = await SessionBridge.buildPlanGoal(sessionId);

      expect(goal).toBe("Build me an API gateway");
    });

    it("should include 'Previous plan:' and 'User feedback:' when plan + feedback exist", async () => {
      addUserMessage(sessionId, "Build me an API");

      const plan = createTestPlan();
      await getPlanAdapter().write(plan.planId, JSON.stringify(plan));
      SessionBridge.storePlanResult(sessionId, { planId: plan.planId }, TEST_MODEL);

      addUserMessage(sessionId, "Add authentication to the plan");

      const goal = await SessionBridge.buildPlanGoal(sessionId);

      expect(goal).toContain("Previous plan:");
      expect(goal).toContain("User feedback:");
      expect(goal).toContain("Add authentication to the plan");
      expect(goal).toContain(plan.planId);
    });
  });

  describe("buildDirectMessages", () => {
    it("should return messages in chronological order with correct roles", () => {
      addUserMessage(sessionId, "Hello");
      addAssistantMessage(sessionId, "Hi there!");
      addUserMessage(sessionId, "How are you?");
      addAssistantMessage(sessionId, "I'm good!");

      const messages = SessionBridge.buildDirectMessages(sessionId);

      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ role: "user", content: "Hello" });
      expect(messages[1]).toEqual({ role: "assistant", content: "Hi there!" });
      expect(messages[2]).toEqual({ role: "user", content: "How are you?" });
      expect(messages[3]).toEqual({ role: "assistant", content: "I'm good!" });
    });

    it("should return empty array for session with no messages", () => {
      const messages = SessionBridge.buildDirectMessages(sessionId);
      expect(messages).toHaveLength(0);
    });

    it("should exclude plan-id marker parts from direct messages", () => {
      addUserMessage(sessionId, "Hello");
      SessionBridge.storePlanResult(sessionId, { planId: "plan-1" }, TEST_MODEL);
      addUserMessage(sessionId, "Continue chat");

      const messages = SessionBridge.buildDirectMessages(sessionId);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: "user", content: "Hello" });
      expect(messages[1]).toEqual({ role: "user", content: "Continue chat" });
    });
  });

  describe("storeDirectResult", () => {
    it("should store output string as TextPart in session", () => {
      const output = "Here is the API documentation you requested.";

      SessionBridge.storeDirectResult(sessionId, output, TEST_MODEL);

      const messages = Session.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");

      const parts = Session.getParts(messages[0].id);
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("text");
      expect((parts[0] as Message.TextPart).text).toBe(output);
    });

    it("should write linked EventLog envelopes for direct result writeback", async () => {
      const output = "Here is the API documentation you requested.";

      SessionBridge.storeDirectResult(sessionId, output, TEST_MODEL);

      const messages = Session.getMessages(sessionId);
      const message = messages[0] as Message.AssistantMessage;
      const part = Session.getParts(message.id)[0] as Message.TextPart;
      const events = await replayEvents(sessionId);

      expect(events).toHaveLength(5);
      expect(events.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(events.every((row) => Date.parse(row.timestamp) > 0)).toBe(true);

      const writebackEvents = filterBusEvents(events, "ingress.writeback.");
      expect(writebackEvents.map((row) => row.name)).toEqual([
        "ingress.writeback.direct_result",
        "ingress.writeback.message.write",
        "ingress.writeback.part.write",
      ]);

      const writeback = expectBusEvent(writebackEvents[0], "ingress.writeback.direct_result");
      const messageWrite = expectBusEvent(writebackEvents[1], "ingress.writeback.message.write");
      const partWrite = expectBusEvent(writebackEvents[2], "ingress.writeback.part.write");
      expect(messageWrite.parentActionId).toBe(writeback.actionId);
      expect(partWrite.parentActionId).toBe(messageWrite.actionId);

      const sessionMessage = findBusEvent(events, "session.message.added");
      const sessionPart = findBusEvent(events, "session.part.added");
      expect(sessionPart.parentActionId).toBe(sessionMessage.actionId);
      expect(expectPayload(sessionMessage)).toMatchObject({
        sessionId,
        messageId: message.id,
        role: "assistant",
        status: "completed",
        providerId: "anthropic",
        modelId: "claude-3-haiku",
      });
      expect(expectPayload(sessionPart)).toMatchObject({
        sessionId,
        messageId: message.id,
        partMessageId: message.id,
        partId: part.id,
        partType: "text",
      });
      expect(expectPayload(writeback)).toMatchObject({
        sessionId,
        mode: "direct",
        source: "session-bridge",
        messageId: message.id,
        partId: part.id,
        role: "assistant",
      });
      expect(expectPayload(partWrite)).toMatchObject({
        sessionId,
        messageId: message.id,
        partId: part.id,
        partType: "text",
      });
      expect(part.text).toBe(output);
    });
  });
});
