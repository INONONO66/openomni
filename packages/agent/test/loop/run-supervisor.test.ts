import { describe, it, expect } from "bun:test";
import {
  RunSupervisor,
  RunBudget,
  RunState,
} from "../../src/worker/policy/run-supervisor";

describe("RunSupervisor", () => {
  describe("createState", () => {
    it("initializes with current timestamp and zero counts", () => {
      const before = Date.now();
      const state = RunSupervisor.createState();
      const after = Date.now();

      expect(state.startTime).toBeGreaterThanOrEqual(before);
      expect(state.startTime).toBeLessThanOrEqual(after);
      expect(state.turns).toBe(0);
      expect(state.toolCalls).toBe(0);
      expect(state.toolRuntimeMs).toBe(0);
    });
  });

  describe("checkBudget", () => {
    const budget: RunBudget = {
      maxWallTimeMs: 10000,
      maxTurns: 10,
      maxToolCalls: 20,
      maxToolRuntimeMs: 5000,
    };

    it("returns 'ok' when within limits", () => {
      const state: RunState = {
        startTime: Date.now(),
        turns: 5,
        toolCalls: 10,
        toolRuntimeMs: 2500,
      };

      const status = RunSupervisor.checkBudget(state, budget);
      expect(status).toBe("ok");
    });

    it("returns 'exceeded' when turns exceed maxTurns", () => {
      const state: RunState = {
        startTime: Date.now(),
        turns: 11,
        toolCalls: 10,
        toolRuntimeMs: 2500,
      };

      const status = RunSupervisor.checkBudget(state, budget);
      expect(status).toBe("exceeded");
    });

    it("returns 'exceeded' when toolCalls exceed maxToolCalls", () => {
      const state: RunState = {
        startTime: Date.now(),
        turns: 5,
        toolCalls: 21,
        toolRuntimeMs: 2500,
      };

      const status = RunSupervisor.checkBudget(state, budget);
      expect(status).toBe("exceeded");
    });
  });

  describe("recordTurn", () => {
    it("increments turn count", () => {
      const state: RunState = {
        startTime: Date.now(),
        turns: 5,
        toolCalls: 10,
        toolRuntimeMs: 2500,
      };

      const newState = RunSupervisor.recordTurn(state);

      expect(newState.turns).toBe(6);
      expect(newState.toolCalls).toBe(10);
      expect(newState.toolRuntimeMs).toBe(2500);
      expect(newState.startTime).toBe(state.startTime);
    });
  });

  describe("recordToolCall", () => {
    it("increments toolCalls and adds to toolRuntimeMs", () => {
      const state: RunState = {
        startTime: Date.now(),
        turns: 5,
        toolCalls: 10,
        toolRuntimeMs: 2500,
      };

      const newState = RunSupervisor.recordToolCall(state, 500);

      expect(newState.toolCalls).toBe(11);
      expect(newState.toolRuntimeMs).toBe(3000);
      expect(newState.turns).toBe(5);
      expect(newState.startTime).toBe(state.startTime);
    });
  });
});
