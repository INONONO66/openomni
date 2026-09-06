import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  anthropicModel as model,
  assistantMessage as buildAssistantMessage,
} from "../helpers/fixtures";
import { Operational, type Message } from "@openomni/protocol";
import { Bus } from "../helpers/observation";
import { Processor } from "../../src/processor";
describe("Processor attempt settlement", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("records synchronous stream failure before process promise settlement", async () => {
    const failure = new Error("synchronous stream failure");
    const messages: Message.WithParts[] = [];
    const publish = spyOn(Bus, "publish");
    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-sync", "session-sync", "parent-sync"),
      sessionID: "session-sync",
      model,
      abort: new AbortController().signal,
      events: Bus,
      sink: {
        onMessage: (message) => messages.push(message),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
      createStream: () => {
        throw failure;
      },
      trace: { traceId: "trace-sync", sessionId: "session-sync" },
    });

    try {
      const processing = processor.process({ system: "", promptText: "" });
      const rejection = processing.catch((error) => error);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.info).toMatchObject({ finish: "error" });
      expect(
        publish.mock.calls
          .filter((call) => call[0] === Operational.Events.Info)
          .map((call) => (call[1] as { context?: { stateType?: string } }).context?.stateType)
          .filter((state): state is string => state !== undefined),
      ).toEqual(["busy", "idle"]);
      expect(await rejection).toBe(failure);
    } finally {
      publish.mockRestore();
    }
  });

  test("records rejected createStream promises in the first rejection continuation", async () => {
    const failure = new Error("rejected createStream promise");
    const messages: Message.WithParts[] = [];
    const publish = spyOn(Bus, "publish");
    const processor = Processor.create({
      assistantMessage: buildAssistantMessage("msg-rejected", "session-rejected", "parent"),
      sessionID: "session-rejected",
      model,
      abort: new AbortController().signal,
      events: Bus,
      sink: {
        onMessage: (message) => messages.push(message),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
      },
      createStream: () => Promise.reject(failure),
      trace: { traceId: "trace-rejected", sessionId: "session-rejected" },
    });

    try {
      const processing = processor.process({ system: "", promptText: "" });
      const rejection = processing.catch((error) => error);
      await Promise.resolve();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.info).toMatchObject({ finish: "error" });
      expect(
        publish.mock.calls
          .filter((call) => call[0] === Operational.Events.Info)
          .map((call) => (call[1] as { context?: { stateType?: string } }).context?.stateType)
          .filter((state): state is string => state !== undefined),
      ).toEqual(["busy", "idle"]);
      expect(await rejection).toBe(failure);
    } finally {
      publish.mockRestore();
    }
  });
});
