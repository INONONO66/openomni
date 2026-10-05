/**
 * #1253 — gateway frames after the four-RPC switch: `session_bound` keeps its
 * fields, and the page's `usage` is byte-equal to the `llm` attempt fold DTO
 * (`Inspect.attemptUsage` over the same committed chain window). Everything
 * here is a synchronous read over a real kernel — event-driven data, no waits.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Core, Inspect } from "@openomni/agent";
import { SessionRead } from "@openomni/protocol";
import { readSessionCursor } from "../src/gateway";
import { clusterTempDir } from "../../../packages/agent/test/helpers/cluster-runtime";
import { runEffect } from "./helpers/effect";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-gateway-frame-");
const sessionId = "frame-session";
const file = `${sessionsDir}/${sessionId}.sqlite`;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Materialize one session and commit an `llm` attempt intent/result pair. */
async function seedKernel(): Promise<Core.SessionHandleStore.SessionKernel> {
  const catalog = Core.openCatalogStore(catalogFile, { now: () => 1 });
  const store = Core.openSessionStore(file, { now: () => 1 });
  const kernel = Core.SessionHandleStore.createSessionKernel(store, catalog);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: 1,
    }),
  );
  catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
  const fence = catalog.rotateFence(sessionId);
  await runEffect(kernel.adoptFence({ sessionId, owner: "framer", fence }));
  const row = kernel.row(sessionId);
  const parentId = kernel.latestAction(sessionId)?.id ?? null;
  await runEffect(
    kernel.commit({
      sessionId,
      owner: "framer",
      fence,
      now: 5,
      expectedRevision: row.revision,
      actions: [
        {
          id: "llm-attempt-1",
          parentId,
          sessionId,
          kind: "llm",
          intent: { encodingVersion: 1, value: { phase: "intent", attempt: 1 } },
          effect: { encodingVersion: 1, value: { phase: "intent" } },
          ts: 5,
          irreversible: true,
        },
        {
          id: "llm-attempt-1-result",
          parentId: "llm-attempt-1",
          sessionId,
          kind: "llm",
          intent: { encodingVersion: 1, value: { phase: "result" } },
          effect: {
            encodingVersion: 1,
            value: {
              phase: "result",
              usageProvenance: "reported",
              evidence: { usage: { inputTokens: 3, outputTokens: 2 } },
            },
          },
          ts: 6,
          irreversible: true,
        },
      ],
      state: row.state,
    }),
  );
  return kernel;
}

test("attemptUsage in the read frame is byte-equal to the llm attempt fold DTO", async () => {
  const kernel = await seedKernel();
  const frame = readSessionCursor(kernel, { type: "session_read", sessionId, limit: 256 });
  expect(frame.type).toBe("session_snapshot");
  if (frame.type === "session_gap") throw new Error("seeded session returned a gap");
  const foldDto = Inspect.attemptUsage(
    kernel.historyPage(sessionId, { afterRevision: 0, limit: 256 }).actions,
  );
  expect(foldDto).toEqual([
    { attemptId: "llm-attempt-1", provenance: "reported", inputTokens: 3, outputTokens: 2 },
  ]);
  expect(JSON.stringify(frame.usage)).toBe(JSON.stringify(foldDto));
  // The frame itself round-trips the frozen page schema.
  expect(SessionRead.Page.parse(frame)).toEqual(frame);
});

test("session_bound keeps its fields and the page frame keeps its field set", () => {
  expect(Object.keys(SessionRead.Bound.shape)).toEqual(["type", "result"]);
  expect(Object.keys(SessionRead.Receipt.shape)).toEqual(["type", "status"]);
  // #1257 adds exactly one OPTIONAL field: `ancestry`, the fork projection the
  // issue requires on the gateway read DTO ("gateway DTO show parent and
  // anchor"). Every pre-#1257 field keeps its position; a page without a fork
  // still parses with no ancestry key on the wire.
  expect(Object.keys(SessionRead.Page.shape)).toEqual([
    "type",
    "sessionId",
    "state",
    "phase",
    "phaseSince",
    "epoch",
    "afterRevision",
    "headRevision",
    "nextRevision",
    "actions",
    "usage",
    "toolWallMs",
    "ancestry",
  ]);
  expect(SessionRead.Page.shape.ancestry.safeParse(undefined).success).toBeTrue();
  const bound = SessionRead.Bound.parse({
    type: "session_bound",
    result: {
      status: "executed",
      handle: { messageId: "m-1", target: sessionId },
      delivery: { kind: "session" },
    },
  });
  expect(bound.result.status).toBe("executed");
});
