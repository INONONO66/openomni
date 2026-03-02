import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NoopNotificationAdapter } from "../../../src/legacy/ingress/engine";
import type { NotificationAdapter } from "../../../src/legacy/ingress/interfaces";
import type {
  NotificationRequest,
  NotificationResult,
} from "@openomni/protocol";

describe("NotificationAdapter", () => {
  describe("NotificationAdapter interface", () => {
    it("should have name and notify method", () => {
      const adapter: NotificationAdapter = {
        name: "test",
        async notify() {
          return { delivered: true };
        },
      };

      expect(adapter.name).toBe("test");
      expect(typeof adapter.notify).toBe("function");
    });

    it("should accept NotificationRequest and return NotificationResult", async () => {
      const adapter: NotificationAdapter = {
        name: "test",
        async notify(
          request: NotificationRequest,
        ): Promise<NotificationResult> {
          return {
            delivered: true,
            destination: "test@example.com",
            externalMessageId: "msg-123",
          };
        },
      };

      const request: NotificationRequest = {
        type: "alert",
        severity: "info",
        title: "Test Alert",
        body: "This is a test notification",
      };

      const result = await adapter.notify(request);
      expect(result.delivered).toBe(true);
      expect(result.destination).toBe("test@example.com");
      expect(result.externalMessageId).toBe("msg-123");
    });
  });

  describe("NoopNotificationAdapter", () => {
    it("should have name 'noop'", () => {
      expect(NoopNotificationAdapter.name).toBe("noop");
    });

    it("should return { delivered: true } for any notification", async () => {
      const request: NotificationRequest = {
        type: "alert",
        severity: "warning",
        title: "Test",
        body: "Test body",
      };

      const result = await NoopNotificationAdapter.notify(request);
      expect(result.delivered).toBe(true);
    });

    it("should not include destination or externalMessageId", async () => {
      const request: NotificationRequest = {
        type: "alert",
        severity: "error",
        title: "Error",
        body: "Error body",
      };

      const result = await NoopNotificationAdapter.notify(request);
      expect(result.destination).toBeUndefined();
      expect(result.externalMessageId).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it("should handle requests with optional fields", async () => {
      const request: NotificationRequest = {
        type: "alert",
        severity: "info",
        title: "Test",
        body: "Test body",
        taskId: "task-123",
        runId: "run-456",
        traceId: "trace-789",
        artifactRefs: ["artifact-1", "artifact-2"],
        conversationSessionId: "session-123",
        deliveryHint: "dm",
        metadata: { key: "value" },
      };

      const result = await NoopNotificationAdapter.notify(request);
      expect(result.delivered).toBe(true);
    });
  });

  describe("NotificationAdapter implementations", () => {
    it("should support custom adapter with error handling", async () => {
      const adapter: NotificationAdapter = {
        name: "custom",
        async notify(
          request: NotificationRequest,
        ): Promise<NotificationResult> {
          if (request.severity === "error") {
            return {
              delivered: false,
              error: "Failed to deliver error notification",
            };
          }
          return { delivered: true, destination: "custom-channel" };
        },
      };

      const errorRequest: NotificationRequest = {
        type: "alert",
        severity: "error",
        title: "Critical Error",
        body: "Something went wrong",
      };

      const result = await adapter.notify(errorRequest);
      expect(result.delivered).toBe(false);
      expect(result.error).toBe("Failed to deliver error notification");
    });

    it("should support adapter with external message ID tracking", async () => {
      const adapter: NotificationAdapter = {
        name: "tracking",
        async notify(
          request: NotificationRequest,
        ): Promise<NotificationResult> {
          const messageId = `msg-${Date.now()}`;
          return {
            delivered: true,
            destination: request.conversationSessionId ?? "default",
            externalMessageId: messageId,
          };
        },
      };

      const request: NotificationRequest = {
        type: "alert",
        severity: "info",
        title: "Test",
        body: "Test body",
        conversationSessionId: "session-abc",
      };

      const result = await adapter.notify(request);
      expect(result.delivered).toBe(true);
      expect(result.destination).toBe("session-abc");
      expect(result.externalMessageId).toMatch(/^msg-\d+$/);
    });
  });
});
