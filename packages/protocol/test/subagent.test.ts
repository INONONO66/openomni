import { describe, expect, test } from "bun:test";
import { Subagent } from "../src/index.js";

describe("Subagent schemas", () => {
  test("ChildSessionMeta accepts valid data", () => {
    expect(
      Subagent.ChildSessionMeta.parse({
        kind: "subagent",
        parentSessionId: "session-1",
        parentRunId: "run-1",
        agentName: "coder",
        spawnDepth: 1,
        status: "running",
      }),
    ).toEqual({
      kind: "subagent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
      agentName: "coder",
      spawnDepth: 1,
      status: "running",
    });
  });

  test("ChildSessionMeta rejects invalid data", () => {
    expect(
      Subagent.ChildSessionMeta.safeParse({
        kind: "invalid",
        agentName: "coder",
        spawnDepth: -1,
        status: "running",
      }).success,
    ).toBe(false);
  });

  test("WorkerRun accepts valid data", () => {
    expect(
      Subagent.WorkerRun.parse({
        runId: "run-1",
        sessionId: "session-1",
        parentRunId: "run-parent",
        assignedStepId: "step-1",
        title: "Implement feature",
        prompt: "Do the work",
        executorKind: "external_api",
        status: "running",
        startedAt: 1,
        endedAt: 2,
        lastMessageId: "msg-1",
        resumeCount: 2,
      }),
    ).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      parentRunId: "run-parent",
      assignedStepId: "step-1",
      title: "Implement feature",
      prompt: "Do the work",
      executorKind: "external_api",
      status: "running",
      startedAt: 1,
      endedAt: 2,
      lastMessageId: "msg-1",
      resumeCount: 2,
    });
  });

  test("WorkerRun accepts legacy data without executor kind", () => {
    expect(
      Subagent.WorkerRun.parse({
        runId: "run-1",
        sessionId: "session-1",
        title: "Implement feature",
        prompt: "Do the work",
        status: "running",
        startedAt: 1,
      }),
    ).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      title: "Implement feature",
      prompt: "Do the work",
      status: "running",
      startedAt: 1,
      resumeCount: 0,
    });
  });

  test("WorkerRun rejects invalid data", () => {
    expect(
      Subagent.WorkerRun.safeParse({
        runId: "run-1",
        sessionId: "session-1",
        title: "Implement feature",
        prompt: "Do the work",
        status: "broken",
        startedAt: "now",
        resumeCount: -1,
      }).success,
    ).toBe(false);
  });

  test("SpawnConfig accepts valid data", () => {
    expect(
      Subagent.SpawnConfig.parse({
        parentSessionId: "session-1",
        agentName: "coder",
        title: "Consult on architecture",
        prompt: "Need advice",
        category: "analysis",
        spawnDepth: 0,
      }),
    ).toEqual({
      parentSessionId: "session-1",
      agentName: "coder",
      title: "Consult on architecture",
      prompt: "Need advice",
      category: "analysis",
      spawnDepth: 0,
    });
  });

  test("SpawnConfig rejects invalid data", () => {
    expect(
      Subagent.SpawnConfig.safeParse({
        agentName: "coder",
        title: "Consult on architecture",
        prompt: "Need advice",
        spawnDepth: -1,
      }).success,
    ).toBe(false);
  });

  test("ConsultationMode accepts valid data", () => {
    expect(Subagent.ConsultationMode.parse("fresh-session")).toBe("fresh-session");
  });

  test("ConsultationMode rejects invalid data", () => {
    expect(Subagent.ConsultationMode.safeParse("session").success).toBe(false);
  });

  test("ConsultationRequest accepts valid data", () => {
    expect(
      Subagent.ConsultationRequest.parse({
        sessionId: "session-1",
        runId: "run-1",
        question: "What should I do next?",
        targetAgent: "reviewer",
        mode: "active-session",
        targetSessionId: "session-2",
      }),
    ).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      question: "What should I do next?",
      targetAgent: "reviewer",
      mode: "active-session",
      targetSessionId: "session-2",
    });
  });

  test("ConsultationRequest rejects invalid data", () => {
    expect(
      Subagent.ConsultationRequest.safeParse({
        sessionId: "session-1",
        runId: "run-1",
        question: "What should I do next?",
        targetAgent: "reviewer",
        mode: "active-session",
      }).success,
    ).toBe(false);
  });

  test("ConsultationResult accepts valid data", () => {
    expect(
      Subagent.ConsultationResult.parse({
        consultationId: "consult-1",
        guidance: "Try the simpler approach.",
        source: "mentor-session",
        mode: "fresh-session",
      }),
    ).toEqual({
      consultationId: "consult-1",
      guidance: "Try the simpler approach.",
      source: "mentor-session",
      mode: "fresh-session",
    });
  });

  test("ConsultationResult rejects invalid data", () => {
    expect(
      Subagent.ConsultationResult.safeParse({
        consultationId: "consult-1",
        guidance: "Try the simpler approach.",
        source: "mentor-session",
        mode: "wrong",
      }).success,
    ).toBe(false);
  });
});
