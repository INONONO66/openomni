import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Bus } from "./helpers/bus";
import { WebSocketHandler, type WsConnection } from "@openomni/channels";
import type { LedgerAction, LedgerSession, PlainValue } from "@openomni/protocol";
import { adoptWriter, materializeSession } from "../../../packages/ledger/test/helpers/session";
import type { SessionKernel } from "../src/composition/cluster-runtime";
import { gatewayRuntime, readSessionCursor, webSocketCallbacks } from "../src/gateway";
import { testPlane } from "./helpers/ledger";
import { runSyncEffect } from "./helpers/scoped-effect";
import { testIds } from "./helpers/test-entropy";

function readFixture(sessionId: string) {
  const plane = testPlane();
  const kernel = plane.openKernel(sessionId);
  materializeSession(kernel, sessionId);
  const authority = adoptWriter(kernel, sessionId, "read-writer");
  const commit = (actions: readonly LedgerAction.Append[], state: LedgerSession.State) =>
    runSyncEffect(kernel.commit({
      sessionId,
      owner: authority.owner,
      fence: authority.fence,
      now: actions[actions.length - 1]?.ts ?? 0,
      expectedRevision: kernel.row(sessionId).revision,
      actions: [...actions],
      state,
    }));
  return { plane, kernel, commit };
}

function noteAction(sessionId: string, id: string, ts: number): LedgerAction.Append {
  return {
    id,
    parentId: `${sessionId}:configure`,
    sessionId,
    kind: "message",
    intent: { encodingVersion: 1, value: {} },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts,
  };
}

function toolAction(
  sessionId: string,
  id: string,
  parentId: string,
  phase: "intent" | "result",
  ts: number,
): LedgerAction.Append {
  const outcome: PlainValue =
    phase === "intent" ? { phase: "pending" } : { phase: "result", terminal: "executed" };
  return {
    ts,
    irreversible: true,
    kind: "tool",
    id,
    parentId,
    sessionId,
    effect: { encodingVersion: 1, value: outcome },
    intent: { encodingVersion: 1, value: { op: "write", phase } },
  };
}

// The read is one transactional revision snapshot: a commit that lands between
// the head capture and the page read is a torn snapshot and must surface as a
// typed gap carrying the durable head, never as a silently inconsistent page.
test("a commit interleaved with the page read yields a typed session gap at the new head", () => {
  const sessionId = "torn-read";
  const { plane, kernel, commit } = readFixture(sessionId);
  try {
    commit([noteAction(sessionId, "note-1", 10)], "idle");
    const headBefore = kernel.row(sessionId).revision;
    const torn: SessionKernel = {
      ...kernel,
      historyPage: (id, options) => {
        commit([noteAction(sessionId, "note-2", 20)], "idle");
        return kernel.historyPage(id, options);
      },
    };
    const response = readSessionCursor(torn, { type: "session_read", sessionId, limit: 256 });
    expect(response).toEqual({
      type: "session_gap",
      sessionId,
      epoch: kernel.row(sessionId).leaseFence,
      headRevision: headBefore + 1,
      oldestRevision: 0,
    });
  } finally {
    plane.close();
  }
});

// toolWallMs folds only settled tool results whose parent is the tool intent:
// the pending intent contributes nothing, the result contributes its
// intent-to-result wall interval.
test("session pages report tool wall time from committed intent/result pairs", () => {
  const sessionId = "tool-wall";
  const { plane, kernel, commit } = readFixture(sessionId);
  try {
    commit([toolAction(sessionId, "tool-1", `${sessionId}:configure`, "intent", 100)], "running");
    const pending = readSessionCursor(kernel, { type: "session_read", sessionId, limit: 256 });
    if (pending.type === "session_gap") throw new Error("unexpected session gap");
    expect(pending.toolWallMs).toBe(0);

    commit([toolAction(sessionId, "tool-1:result", "tool-1", "result", 130)], "idle");
    const settled = readSessionCursor(kernel, { type: "session_read", sessionId, limit: 256 });
    if (settled.type === "session_gap") throw new Error("unexpected session gap");
    expect(settled.type).toBe("session_snapshot");
    expect(settled.toolWallMs).toBe(30);
  } finally {
    plane.close();
  }
});

// A kernel read that throws mid-send must answer the reader with the typed
// session_read_failed error frame instead of tearing down the socket loop.
test("a reader whose kernel read throws receives a session_read_failed error frame", async () => {
  const runtime = gatewayRuntime({ observations: Bus });
  const sessionId = "ws-throw";
  const { plane, kernel } = readFixture(sessionId);
  try {
    const throwing: SessionKernel = {
      ...kernel,
      row: () => {
        throw new Error("kernel read refused");
      },
    };
    const handler = new WebSocketHandler(() => Effect.void, Bus.publish, { now: () => 0, id: testIds("ws") });
    const frames: string[] = [];
    const ws: WsConnection = {
      data: { surfaceKey: "ws::dm:test", authenticated: true, externalId: "reader" },
      send: (frame) => {
        frames.push(frame);
      },
    };
    const gatewaySocket = webSocketCallbacks(runtime, handler, Bus, () => throwing);
    await gatewaySocket.callbacks.message(
      ws,
      JSON.stringify({ type: "session_read", sessionId, limit: 4 }),
    );
    // JSON.parse returns a JSON value, not a gateway frame. No narrowing cast:
    // the equality assertion validates the whole frame after this boundary.
    const decodeJson: (frame: string) => PlainValue = JSON.parse;
    expect(frames.map(decodeJson)).toEqual([
      { type: "error", reason: "session_read_failed", sessionId },
    ]);
    gatewaySocket.callbacks.close(ws);
  } finally {
    plane.close();
    await runtime.dispose();
  }
});
