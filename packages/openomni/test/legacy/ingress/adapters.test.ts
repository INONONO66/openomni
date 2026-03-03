import { describe, it, expect } from "bun:test";
import type {
  EventSourceAdapter,
  EventDecoder,
  InboundEvent,
} from "../../../src/legacy/ingress";

describe("EventSourceAdapter interface", () => {
  it("should allow mock implementation with required properties", () => {
    const mockAdapter: EventSourceAdapter = {
      name: "test-source",
      start: async (emit) => {
        emit({
          id: "evt-1",
          surface: "test",
          name: "test.event",
          payload: { message: "hello" },
        });
      },
      stop: async () => {
        // noop
      },
    };

    expect(mockAdapter.name).toBe("test-source");
    expect(typeof mockAdapter.start).toBe("function");
    expect(typeof mockAdapter.stop).toBe("function");
  });

  it("should allow emit callback to be called with InboundEvent", async () => {
    const events: InboundEvent[] = [];

    const mockAdapter: EventSourceAdapter = {
      name: "collector",
      start: async (emit) => {
        emit({
          id: "evt-1",
          surface: "slack",
          channel: "general",
          name: "message",
          payload: { text: "hello" },
          userId: "user-123",
        });
        emit({
          id: "evt-2",
          surface: "slack",
          channel: "general",
          name: "reaction",
          payload: { emoji: "thumbsup" },
        });
      },
      stop: async () => {
        // noop
      },
    };

    await mockAdapter.start((event) => {
      events.push(event);
    });

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe("evt-1");
    expect(events[1].id).toBe("evt-2");
  });

  it("should support optional InboundEvent fields", async () => {
    const mockAdapter: EventSourceAdapter = {
      name: "minimal",
      start: async (emit) => {
        emit({
          id: "evt-1",
          surface: "webhook",
          name: "trigger",
          payload: null,
          // Optional fields omitted
        });
      },
      stop: async () => {
        // noop
      },
    };

    const events: InboundEvent[] = [];
    await mockAdapter.start((event) => {
      events.push(event);
    });

    expect(events[0].channel).toBeUndefined();
    expect(events[0].userId).toBeUndefined();
    expect(events[0].dedupeKey).toBeUndefined();
  });
});

describe("EventDecoder interface", () => {
  it("should allow mock implementation with required properties", () => {
    const mockDecoder: EventDecoder<string> = {
      name: "json-decoder",
      decode: (raw) => {
        try {
          const parsed = JSON.parse(raw);
          return {
            id: parsed.id,
            surface: parsed.surface,
            name: parsed.name,
            payload: parsed.payload,
          };
        } catch {
          return null;
        }
      },
    };

    expect(mockDecoder.name).toBe("json-decoder");
    expect(typeof mockDecoder.decode).toBe("function");
  });

  it("should support generic type parameter for raw payload", () => {
    interface SlackEvent {
      type: string;
      user: string;
      text: string;
    }

    const slackDecoder: EventDecoder<SlackEvent> = {
      name: "slack-decoder",
      decode: (raw) => {
        if (raw.type === "message") {
          return {
            id: `slack-${Date.now()}`,
            surface: "slack",
            name: "message",
            payload: raw,
            userId: raw.user,
          };
        }
        return null;
      },
    };

    const slackEvent: SlackEvent = {
      type: "message",
      user: "U123",
      text: "hello",
    };

    const decoded = slackDecoder.decode(slackEvent);
    expect(decoded).not.toBeNull();
    expect(decoded?.surface).toBe("slack");
    expect(decoded?.userId).toBe("U123");
  });

  it("should return null when decode is not applicable", () => {
    const decoder: EventDecoder<Record<string, unknown>> = {
      name: "strict-decoder",
      decode: (raw) => {
        if (raw.type === "valid") {
          return {
            id: "evt-1",
            surface: "test",
            name: "event",
            payload: raw,
          };
        }
        return null;
      },
    };

    expect(decoder.decode({ type: "invalid" })).toBeNull();
    expect(decoder.decode({ type: "valid" })).not.toBeNull();
  });

  it("should support default generic type (unknown)", () => {
    const decoder: EventDecoder = {
      name: "generic-decoder",
      decode: (raw) => {
        // raw is unknown, can be anything
        if (typeof raw === "object" && raw !== null && "id" in raw) {
          return {
            id: (raw as any).id,
            surface: "generic",
            name: "event",
            payload: raw,
          };
        }
        return null;
      },
    };

    expect(decoder.decode({ id: "evt-1", data: "test" })).not.toBeNull();
    expect(decoder.decode("string")).toBeNull();
    expect(decoder.decode(123)).toBeNull();
  });

  it("should allow chaining multiple decoders", () => {
    const decoders: EventDecoder[] = [
      {
        name: "slack-decoder",
        decode: (raw) => {
          if (typeof raw === "object" && raw !== null && "slack_event" in raw) {
            return {
              id: "slack-evt",
              surface: "slack",
              name: "event",
              payload: raw,
            };
          }
          return null;
        },
      },
      {
        name: "webhook-decoder",
        decode: (raw) => {
          if (typeof raw === "object" && raw !== null && "webhook_id" in raw) {
            return {
              id: "webhook-evt",
              surface: "webhook",
              name: "event",
              payload: raw,
            };
          }
          return null;
        },
      },
    ];

    const slackPayload = { slack_event: true };
    const webhookPayload = { webhook_id: "123" };

    let decoded = null;
    for (const decoder of decoders) {
      decoded = decoder.decode(slackPayload);
      if (decoded) break;
    }
    expect(decoded?.surface).toBe("slack");

    decoded = null;
    for (const decoder of decoders) {
      decoded = decoder.decode(webhookPayload);
      if (decoded) break;
    }
    expect(decoded?.surface).toBe("webhook");
  });
});

describe("EventSourceAdapter and EventDecoder integration", () => {
  it("should work together in a pipeline", async () => {
    const decoder: EventDecoder<string> = {
      name: "json-decoder",
      decode: (raw) => {
        try {
          const parsed = JSON.parse(raw);
          return {
            id: parsed.id,
            surface: parsed.surface,
            name: parsed.name,
            payload: parsed.payload,
          };
        } catch {
          return null;
        }
      },
    };

    const adapter: EventSourceAdapter = {
      name: "json-source",
      start: async (emit) => {
        const rawEvents = [
          JSON.stringify({
            id: "evt-1",
            surface: "api",
            name: "request",
            payload: { path: "/api/test" },
          }),
          JSON.stringify({
            id: "evt-2",
            surface: "api",
            name: "request",
            payload: { path: "/api/other" },
          }),
        ];

        for (const raw of rawEvents) {
          const decoded = decoder.decode(raw);
          if (decoded) {
            emit(decoded);
          }
        }
      },
      stop: async () => {
        // noop
      },
    };

    const events: InboundEvent[] = [];
    await adapter.start((event) => {
      events.push(event);
    });

    expect(events).toHaveLength(2);
    expect(events[0].surface).toBe("api");
    expect(events[1].surface).toBe("api");
  });
});
