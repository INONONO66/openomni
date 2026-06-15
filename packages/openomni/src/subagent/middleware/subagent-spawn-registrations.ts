import type { PolicyRegistration } from "@openomni/agent";
import { Session, WorkerRun } from "@openomni/session";
import {
  allowDecision,
  defaultCancelHardTimeoutMs,
  evaluateBooleanPolicy,
} from "./subagent-spawn-decisions.js";
import * as Definitions from "./subagent-spawn-definitions.js";
import type { PreSpawnState } from "./subagent-spawn-types.js";

function createSessionExistence(state: PreSpawnState): PolicyRegistration {
  return {
    ...Definitions.SessionExistence,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation === "wait") {
        return evaluateBooleanPolicy({
          action: "subagent.wait",
          resource: state.sessionId,
          field: "sessionCheckRequired",
          allowed: true,
          allowReason: "wait resolves worker run directly",
          denyReason: "wait session check blocked",
        });
      }

      const session = Session.get(state.sessionId);
      if (!session) {
        return evaluateBooleanPolicy({
          action: `subagent.${state.operation}`,
          resource: state.sessionId,
          field: "sessionExists",
          allowed: false,
          allowReason: "session exists",
          denyReason: `Session not found: ${state.sessionId}`,
        });
      }

      state.session = session;
      return evaluateBooleanPolicy({
        action: `subagent.${state.operation}`,
        resource: state.sessionId,
        field: "sessionExists",
        allowed: true,
        allowReason: "session exists",
        denyReason: `Session not found: ${state.sessionId}`,
      });
    },
  };
}

function createActiveRunGuard(state: PreSpawnState): PolicyRegistration {
  return {
    ...Definitions.ActiveRun,
    failPolicy: "fail-closed",
    async fn() {
      if (state.operation !== "resume") {
        return evaluateBooleanPolicy({
          action: `subagent.${state.operation}`,
          resource: state.sessionId,
          field: "activeRunAllowed",
          allowed: true,
          allowReason: "active-run check not required",
          denyReason: "Session already has an active run",
        });
      }

      const runs = await WorkerRun.listBySession(state.sessionId);
      const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
      state.runs = runs;
      state.latestRun = latestRun;

      if (latestRun?.status === "running" || latestRun?.status === "starting") {
        return evaluateBooleanPolicy({
          action: "subagent.resume",
          resource: state.sessionId,
          field: "activeRunAllowed",
          allowed: false,
          allowReason: "session has no active latest run",
          denyReason: "Session already has an active run",
        });
      }

      return evaluateBooleanPolicy({
        action: "subagent.resume",
        resource: state.sessionId,
        field: "activeRunAllowed",
        allowed: true,
        allowReason: "session has no active latest run",
        denyReason: "Session already has an active run",
      });
    },
  };
}

function createCancelTimeout(state: PreSpawnState): PolicyRegistration {
  return {
    ...Definitions.CancelTimeout,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation !== "cancel") {
        return allowDecision("subagent.cancel-timeout", "cancel timeout not required");
      }

      state.cancelHardTimeoutMs = state.hardTimeoutMs ?? defaultCancelHardTimeoutMs;
      return allowDecision("subagent.cancel-timeout", "cancel timeout resolved");
    },
  };
}

function createWaitTimeout(state: PreSpawnState): PolicyRegistration {
  return {
    ...Definitions.WaitTimeout,
    failPolicy: "fail-closed",
    fn: () => {
      if (state.operation !== "wait") {
        return allowDecision("subagent.wait-timeout", "wait timeout not required");
      }

      state.waitTimeoutMs = state.timeoutMs;
      return allowDecision(
        "subagent.wait-timeout",
        state.timeoutMs === undefined ? "wait timeout disabled" : "wait timeout configured",
      );
    },
  };
}

export function createSubagentSpawnRegistrations(state: PreSpawnState): PolicyRegistration[] {
  return [
    createSessionExistence(state),
    createActiveRunGuard(state),
    createCancelTimeout(state),
    createWaitTimeout(state),
  ];
}
