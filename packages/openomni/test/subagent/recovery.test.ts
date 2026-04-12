import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Plan, PlanStep } from "@openomni/protocol";
import { Session, Storage, WorkerRun } from "@openomni/session";
import { recoverSubagentSessions } from "../../src/subagent/recovery";
import { SubagentRuntime } from "../../src/subagent/runtime";
import { ReviewLoop } from "../../src/team/review-loop";
import { RunLedger } from "../../src/team/run-ledger";
import { TeamOrchestrator } from "../../src/team/team-orchestrator";
import type { Teammate } from "../../src/team/teammate";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };
const sessionModel = { providerID: "anthropic", modelID: "claude-3-haiku-20240307" };

function makeSteps(ids: string[]): PlanStep[] {
  return ids.map((stepId) => ({
    stepId,
    description: `${stepId} task`,
    expectedOutput: `${stepId} output`,
    dependsOn: [],
  }));
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    planId: "plan-recovery",
    goal: "recover subagent sessions",
    steps,
    createdAt: new Date(),
    version: 1,
  };
}

function makeConfig(overrides?: {
  orchestrationSessionId?: string;
  subagentRuntime?: Teammate.SubagentRuntime;
}): TeamOrchestrator.OrchestratorConfig {
  return {
    reviewModel: model,
    teammates: new Map<string, Teammate.TeammateConfig>(),
    defaultTeammateConfig: {
      agentId: "worker",
      model,
    },
    orchestrationSessionId: overrides?.orchestrationSessionId,
    subagentRuntime: overrides?.subagentRuntime,
  };
}

beforeEach(() => {
  Storage.reset();
});

describe("recoverSubagentSessions", () => {
  it("recovers ledger state and interrupts incomplete worker runs", async () => {
    const orchestrationSession = Session.create({ title: "orchestrator", model: sessionModel });
    const steps = makeSteps(["step-1", "step-2"]);
    const ledger = RunLedger.create(steps, { sessionId: orchestrationSession.id });

    ledger.transition("step-1", "running");
    ledger.recordAttempt("step-1");

    const child = Session.createChild({
      parentSessionId: orchestrationSession.id,
      title: "worker",
      model: sessionModel,
      workerMeta: { status: "running" },
    });

    await WorkerRun.create(child.id, {
      runId: "run-running",
      title: "running task",
      prompt: "do work",
    });
    await WorkerRun.updateStatus(child.id, "run-running", "starting");
    await WorkerRun.updateStatus(child.id, "run-running", "running");

    await WorkerRun.create(child.id, {
      runId: "run-starting",
      title: "starting task",
      prompt: "boot up",
    });
    await WorkerRun.updateStatus(child.id, "run-starting", "starting");

    const cancelSpy = spyOn(SubagentRuntime, "cancel").mockResolvedValue();

    try {
      const recovered = await recoverSubagentSessions(orchestrationSession.id, steps);

      expect(recovered.getStepState("step-1")).toMatchObject({
        state: "running",
        attempts: 1,
      });
      expect(recovered.getStepState("step-2")).toMatchObject({
        state: "ready",
        attempts: 0,
      });
      expect(Session.listChildren(orchestrationSession.id).map((session) => session.id)).toContain(
        child.id,
      );
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith({ sessionId: child.id });

      const runs = await WorkerRun.listBySession(child.id);
      expect(runs).toHaveLength(2);
      expect(runs.map((run) => run.status)).toEqual(["interrupted", "interrupted"]);
      for (const run of runs) {
        expect(run.endedAt).toEqual(expect.any(Number));
      }
    } finally {
      cancelSpy.mockRestore();
    }
  });
});

describe("TeamOrchestrator ledger persistence", () => {
  it("persists ledger events under the orchestration session id", async () => {
    const orchestrationSession = Session.create({ title: "orchestrator", model: sessionModel });
    const reviewSpy = spyOn(ReviewLoop, "review").mockResolvedValue({ decision: "accept" });

    const runtime: Teammate.SubagentRuntime = {
      async spawn() {
        return {
          sessionId: "worker-session-1",
          runId: "worker-run-1",
          output: "done",
          finishReason: "stop",
        };
      },
      async send(config) {
        return {
          sessionId: config.sessionId,
          runId: "worker-run-2",
          output: "done",
          finishReason: "stop",
        };
      },
    };

    try {
      const result = await TeamOrchestrator.execute(
        makePlan(makeSteps(["step-1"])),
        makeConfig({
          orchestrationSessionId: orchestrationSession.id,
          subagentRuntime: runtime,
        }),
      );

      expect(result.status).toBe("completed");

      const ledgerEvents = Storage.get()
        .eventLog!.replay(orchestrationSession.id)
        .filter((row) => row.type.startsWith("ledger."));

      expect(ledgerEvents.map((row) => row.type)).toContain("ledger.transition");
      expect(ledgerEvents.map((row) => row.type)).toContain("ledger.attempt");
      expect(ledgerEvents.length).toBeGreaterThanOrEqual(3);
    } finally {
      reviewSpy.mockRestore();
    }
  });
});
