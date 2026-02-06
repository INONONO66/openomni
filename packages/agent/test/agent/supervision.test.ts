import { describe, it, expect, beforeEach } from "bun:test";
import {
  Supervisor,
  SupervisionPolicy,
  type ChildRunStatus,
} from "../../src/agent/supervision";

describe("Supervisor", () => {
  let policy: SupervisionPolicy;

  beforeEach(() => {
    policy = {
      maxRetries: 3,
      timeoutMs: 5000,
      escalationNodeId: "escalation-node-1",
    };
  });

  describe("createState", () => {
    it("should return initial pending state", () => {
      const state = Supervisor.createState();

      expect(state.status).toBe("pending");
      expect(state.attempt).toBe(0);
      expect(state.startTime).toBeUndefined();
      expect(state.error).toBeUndefined();
    });
  });

  describe("recordAttempt", () => {
    it("should increment attempt and set status to running", () => {
      const state = Supervisor.createState();
      const before = Date.now();
      const updated = Supervisor.recordAttempt(state);
      const after = Date.now();

      expect(updated.attempt).toBe(1);
      expect(updated.status).toBe("running");
      expect(updated.startTime).toBeDefined();
      expect(updated.startTime! >= before).toBe(true);
      expect(updated.startTime! <= after).toBe(true);
    });

    it("should increment attempt on subsequent calls", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);
      expect(state.attempt).toBe(1);

      state = Supervisor.recordAttempt(state);
      expect(state.attempt).toBe(2);

      state = Supervisor.recordAttempt(state);
      expect(state.attempt).toBe(3);
    });
  });

  describe("recordSuccess", () => {
    it("should set status to succeeded", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);
      const updated = Supervisor.recordSuccess(state);

      expect(updated.status).toBe("succeeded");
      expect(updated.attempt).toBe(1);
      expect(updated.startTime).toBeDefined();
    });
  });

  describe("recordFailure", () => {
    it("should set status to failed with error", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);
      const error = new Error("Test error");
      const updated = Supervisor.recordFailure(state, error);

      expect(updated.status).toBe("failed");
      expect(updated.error).toBe(error);
      expect(updated.error?.message).toBe("Test error");
      expect(updated.attempt).toBe(1);
    });
  });

  describe("recordEscalation", () => {
    it("should set status to escalated", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);
      const error = new Error("Max retries exceeded");
      state = Supervisor.recordFailure(state, error);
      const updated = Supervisor.recordEscalation(state);

      expect(updated.status).toBe("escalated");
      expect(updated.error).toBe(error);
      expect(updated.attempt).toBe(1);
    });
  });

  describe("shouldRetry", () => {
    it("should return true when failed and attempts less than maxRetries", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);
      state = Supervisor.recordFailure(state, new Error("Test error"));

      expect(Supervisor.shouldRetry(state, policy)).toBe(true);
    });

    it("should return false when status is not failed", () => {
      const state = Supervisor.createState();
      expect(Supervisor.shouldRetry(state, policy)).toBe(false);
    });

    it("should return false when attempts equal maxRetries", () => {
      let state = Supervisor.createState();
      for (let i = 0; i < policy.maxRetries; i++) {
        state = Supervisor.recordAttempt(state);
      }
      state = Supervisor.recordFailure(state, new Error("Test error"));

      expect(Supervisor.shouldRetry(state, policy)).toBe(false);
    });

    it("should return false when attempts exceed maxRetries", () => {
      let state = Supervisor.createState();
      for (let i = 0; i < policy.maxRetries + 1; i++) {
        state = Supervisor.recordAttempt(state);
      }
      state = Supervisor.recordFailure(state, new Error("Test error"));

      expect(Supervisor.shouldRetry(state, policy)).toBe(false);
    });
  });

  describe("shouldEscalate", () => {
    it("should return true when failed, max retries reached, and escalationNodeId set", () => {
      let state = Supervisor.createState();
      for (let i = 0; i < policy.maxRetries; i++) {
        state = Supervisor.recordAttempt(state);
      }
      state = Supervisor.recordFailure(state, new Error("Test error"));

      expect(Supervisor.shouldEscalate(state, policy)).toBe(true);
    });

    it("should return false when status is not failed", () => {
      const state = Supervisor.createState();
      expect(Supervisor.shouldEscalate(state, policy)).toBe(false);
    });

    it("should return false when attempts less than maxRetries", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);
      state = Supervisor.recordFailure(state, new Error("Test error"));

      expect(Supervisor.shouldEscalate(state, policy)).toBe(false);
    });

    it("should return false when escalationNodeId is not set", () => {
      const policyNoEscalation: SupervisionPolicy = {
        maxRetries: 3,
        timeoutMs: 5000,
      };

      let state = Supervisor.createState();
      for (let i = 0; i < policyNoEscalation.maxRetries; i++) {
        state = Supervisor.recordAttempt(state);
      }
      state = Supervisor.recordFailure(state, new Error("Test error"));

      expect(Supervisor.shouldEscalate(state, policyNoEscalation)).toBe(false);
    });
  });

  describe("checkTimeout", () => {
    it("should return true when elapsed time exceeds timeoutMs", async () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);

      // Wait for timeout to be exceeded
      await new Promise((resolve) => setTimeout(resolve, 100));

      const timeoutPolicy: SupervisionPolicy = {
        maxRetries: 3,
        timeoutMs: 50, // 50ms timeout
      };

      expect(Supervisor.checkTimeout(state, timeoutPolicy)).toBe(true);
    });

    it("should return false when elapsed time is within timeout", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);

      expect(Supervisor.checkTimeout(state, policy)).toBe(false);
    });

    it("should return false when startTime is not set", () => {
      const state = Supervisor.createState();
      expect(Supervisor.checkTimeout(state, policy)).toBe(false);
    });

    it("should return false when timeoutMs is 0 or negative", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);

      const noTimeoutPolicy: SupervisionPolicy = {
        maxRetries: 3,
        timeoutMs: 0,
      };

      expect(Supervisor.checkTimeout(state, noTimeoutPolicy)).toBe(false);
    });

    it("should return false when timeoutMs is negative", () => {
      let state = Supervisor.createState();
      state = Supervisor.recordAttempt(state);

      const negativeTimeoutPolicy: SupervisionPolicy = {
        maxRetries: 3,
        timeoutMs: -1,
      };

      expect(Supervisor.checkTimeout(state, negativeTimeoutPolicy)).toBe(false);
    });
  });
});
