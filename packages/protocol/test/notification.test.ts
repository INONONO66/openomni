import { describe, it, expect } from "bun:test";
import {
  NotificationSeverity,
  DeliveryMode,
  NotificationRequest,
  NotificationResult,
} from "../src/notification";

describe("NotificationSeverity", () => {
  it("should parse valid severity values", () => {
    expect(NotificationSeverity.parse("info")).toBe("info");
    expect(NotificationSeverity.parse("warning")).toBe("warning");
    expect(NotificationSeverity.parse("error")).toBe("error");
  });

  it("should reject invalid severity values", () => {
    expect(() => NotificationSeverity.parse("critical")).toThrow();
    expect(() => NotificationSeverity.parse("debug")).toThrow();
    expect(() => NotificationSeverity.parse("")).toThrow();
  });

  it("should infer correct type from schema", () => {
    const severity: NotificationSeverity = "warning";
    expect(severity).toBe("warning");
  });
});

describe("DeliveryMode", () => {
  it("should parse valid delivery modes", () => {
    expect(DeliveryMode.parse("reply_current_session")).toBe(
      "reply_current_session",
    );
    expect(DeliveryMode.parse("dm")).toBe("dm");
    expect(DeliveryMode.parse("new_session")).toBe("new_session");
    expect(DeliveryMode.parse("new_thread")).toBe("new_thread");
  });

  it("should reject invalid delivery modes", () => {
    expect(() => DeliveryMode.parse("email")).toThrow();
    expect(() => DeliveryMode.parse("sms")).toThrow();
    expect(() => DeliveryMode.parse("")).toThrow();
  });

  it("should infer correct type from schema", () => {
    const mode: DeliveryMode = "dm";
    expect(mode).toBe("dm");
  });
});

describe("NotificationRequest", () => {
  it("should parse valid minimal request", () => {
    const request = NotificationRequest.parse({
      type: "task_alert",
      severity: "info",
      title: "Test Alert",
      body: "This is a test",
    });
    expect(request.type).toBe("task_alert");
    expect(request.severity).toBe("info");
    expect(request.title).toBe("Test Alert");
    expect(request.body).toBe("This is a test");
  });

  it("should parse valid request with all optional fields", () => {
    const request = NotificationRequest.parse({
      type: "task_error",
      taskId: "task-123",
      runId: "run-456",
      traceId: "trace-789",
      severity: "error",
      title: "Task Failed",
      body: "The task encountered an error",
      artifactRefs: ["artifact-1", "artifact-2"],
      conversationSessionId: "session-abc",
      deliveryHint: "new_session",
      metadata: { custom: "value", count: 42 },
    });
    expect(request.taskId).toBe("task-123");
    expect(request.runId).toBe("run-456");
    expect(request.traceId).toBe("trace-789");
    expect(request.artifactRefs).toEqual(["artifact-1", "artifact-2"]);
    expect(request.conversationSessionId).toBe("session-abc");
    expect(request.deliveryHint).toBe("new_session");
    expect(request.metadata).toEqual({ custom: "value", count: 42 });
  });

  it("should reject request missing required fields", () => {
    expect(() =>
      NotificationRequest.parse({
        type: "task_alert",
        severity: "info",
      }),
    ).toThrow();

    expect(() =>
      NotificationRequest.parse({
        severity: "info",
        title: "Test",
        body: "Test",
      }),
    ).toThrow();
  });

  it("should reject request with invalid severity", () => {
    expect(() =>
      NotificationRequest.parse({
        type: "task_alert",
        severity: "critical",
        title: "Test",
        body: "Test",
      }),
    ).toThrow();
  });

  it("should reject request with invalid deliveryHint", () => {
    expect(() =>
      NotificationRequest.parse({
        type: "task_alert",
        severity: "info",
        title: "Test",
        body: "Test",
        deliveryHint: "invalid_mode",
      }),
    ).toThrow();
  });

  it("should allow empty artifactRefs array", () => {
    const request = NotificationRequest.parse({
      type: "task_alert",
      severity: "info",
      title: "Test",
      body: "Test",
      artifactRefs: [],
    });
    expect(request.artifactRefs).toEqual([]);
  });

  it("should infer correct type from schema", () => {
    const request: NotificationRequest = {
      type: "task_warning",
      severity: "warning",
      title: "Warning",
      body: "Something to watch",
    };
    expect(request.type).toBe("task_warning");
  });
});

describe("NotificationResult", () => {
  it("should parse valid minimal result", () => {
    const result = NotificationResult.parse({
      delivered: true,
    });
    expect(result.delivered).toBe(true);
  });

  it("should parse valid result with all optional fields", () => {
    const result = NotificationResult.parse({
      delivered: true,
      destination: "slack-channel-123",
      externalMessageId: "msg-xyz",
    });
    expect(result.delivered).toBe(true);
    expect(result.destination).toBe("slack-channel-123");
    expect(result.externalMessageId).toBe("msg-xyz");
  });

  it("should parse failed delivery result", () => {
    const result = NotificationResult.parse({
      delivered: false,
      error: "Failed to connect to Slack",
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toBe("Failed to connect to Slack");
  });

  it("should reject result missing delivered field", () => {
    expect(() =>
      NotificationResult.parse({
        destination: "slack",
      }),
    ).toThrow();
  });

  it("should infer correct type from schema", () => {
    const result: NotificationResult = {
      delivered: true,
      destination: "discord",
    };
    expect(result.delivered).toBe(true);
  });
});

describe("Round-trip serialization", () => {
  it("should round-trip NotificationRequest through JSON", () => {
    const original: NotificationRequest = {
      type: "task_result",
      taskId: "task-1",
      severity: "info",
      title: "Task Complete",
      body: "Task finished successfully",
      metadata: { duration: 1234 },
    };
    const json = JSON.stringify(original);
    const parsed = NotificationRequest.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  it("should round-trip NotificationResult through JSON", () => {
    const original: NotificationResult = {
      delivered: true,
      destination: "webhook",
      externalMessageId: "ext-123",
    };
    const json = JSON.stringify(original);
    const parsed = NotificationResult.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });
});
