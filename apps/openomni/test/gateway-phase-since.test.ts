import { expect, test } from "bun:test";
import { canonicalDigest, type LedgerAction, type LedgerSession } from "@openomni/protocol";
import { adoptWriter, materializeSession } from "../../../packages/ledger/test/helpers/session";
import type { SessionKernel } from "../src/composition/cluster-runtime";
import { readSessionCursor } from "../src/gateway";
import { testPlane } from "./helpers/ledger";
import { runSyncEffect } from "./helpers/scoped-effect";

const SESSION = "phase-since";

function readPhase(kernel: SessionKernel): { phase: string; phaseSince: number } {
  const response = readSessionCursor(kernel, { type: "session_read", sessionId: SESSION, limit: 256 });
  if (response.type === "session_gap") throw new Error("unexpected session gap");
  return { phase: response.phase, phaseSince: response.phaseSince };
}

function turnIntentAction(kernel: SessionKernel, id: string, ts: number): LedgerAction.Append {
  const generation = kernel.latestGenerationFor(SESSION);
  return {
    id,
    parentId: `${SESSION}:configure`,
    sessionId: SESSION,
    kind: "turn",
    intent: {
      encodingVersion: 1,
      value: {
        phase: "intent",
        resultId: `${id}:result`,
        inboxIds: [],
        resumeCount: 0,
        boundaryActionId: null,
        toolsGeneration: generation.generation,
        toolsHash: generation.toolsHash,
        systemHash: generation.systemHash,
        policyGeneration: generation.policyGeneration,
        context: {
          snapshotActionId: id,
          sourceRevision: kernel.row(SESSION).revision,
          foldVersion: 1,
          projectionHash: canonicalDigest([]),
          messageIds: [],
          successorActionId: null,
          projection: [],
        },
      },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts,
  };
}

function turnTerminalAction(
  turnId: string,
  ts: number,
  kind: "result" | "waiting",
): LedgerAction.Append {
  return {
    id: `${turnId}:result`,
    parentId: turnId,
    sessionId: SESSION,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal", turnId } },
    effect: {
      encodingVersion: 1,
      value: {
        phase: "terminal",
        turnId,
        kind,
        text: "done",
        boundaryActionId: turnId,
        resumeCount: 0,
        ...(kind === "waiting" ? { reason: "live_wait", alarmIds: ["alarm-1"] } : {}),
      },
    },
    irreversible: true,
    ts,
  };
}

function noteAction(id: string, ts: number): LedgerAction.Append {
  return {
    id,
    parentId: `${SESSION}:configure`,
    sessionId: SESSION,
    kind: "message",
    intent: { encodingVersion: 1, value: {} },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts,
  };
}

// Review r1 finding 6: phaseSince must be the durable transition that
// established the emitted phase — not a previous turn's terminal and not the
// latest activity, which moves on unrelated commits within one phase.
test("phaseSince derives from the transition that established the emitted phase", () => {
  const plane = testPlane();
  try {
    const kernel = plane.openKernel(SESSION);
    materializeSession(kernel, SESSION);
    const authority = adoptWriter(kernel, SESSION, "phase-writer");
    const commit = (actions: readonly LedgerAction.Append[], state: LedgerSession.State) =>
      runSyncEffect(kernel.commit({
        sessionId: SESSION,
        owner: authority.owner,
        fence: authority.fence,
        now: actions[actions.length - 1]?.ts ?? 0,
        expectedRevision: kernel.row(SESSION).revision,
        actions: [...actions],
        state,
      }));

    // Genesis: idle since materialization (configure at ts 1).
    expect(readPhase(kernel)).toEqual({ phase: "idle", phaseSince: 1 });

    // First turn: running since its own intent, stable across later actions.
    commit([turnIntentAction(kernel, "turn-1", 10)], "running");
    expect(readPhase(kernel)).toEqual({ phase: "running", phaseSince: 10 });
    commit([noteAction("note-1", 50)], "running");
    expect(readPhase(kernel)).toEqual({ phase: "running", phaseSince: 10 });

    // Sealed: completed since the sealing terminal.
    commit([turnTerminalAction("turn-1", 60, "result")], "idle");
    expect(readPhase(kernel)).toEqual({ phase: "completed", phaseSince: 60 });

    // Second turn: running since the NEW intent, not the previous terminal.
    commit([turnIntentAction(kernel, "turn-2", 900)], "running");
    expect(readPhase(kernel)).toEqual({ phase: "running", phaseSince: 900 });

    // Waiting: since the waiting terminal, stable across repeated actions.
    commit([turnTerminalAction("turn-2", 1000, "waiting")], "idle");
    expect(readPhase(kernel)).toEqual({ phase: "waiting_input", phaseSince: 1000 });
    commit([noteAction("note-2", 1500)], "idle");
    expect(readPhase(kernel)).toEqual({ phase: "waiting_input", phaseSince: 1000 });
  } finally {
    plane.close();
  }
});
