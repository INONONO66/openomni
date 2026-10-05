import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Bus, newTraceId } from "./helpers/bus";
import { L0Observation } from "@openomni/protocol";
import { planeOf } from "./helpers/ledger";
import { bounded } from "./helpers/protected-dispatch";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { closeSocket, nextFrame } from "./helpers/ws";
import { nextResidentTurn } from "./helpers/resident-turn";
import { assistantMessage } from "./helpers/assistant-message";

const suite = residentSuite();

/**
 * `session_fork` over the wire (#1257): forking at a turn-terminal anchor
 * answers `session_forked` with the pinned ancestry, the child's read page
 * projects that ancestry and aside, and a bogus anchor is a typed refusal.
 */
test("session_fork forks at a terminal anchor and the child page projects ancestry", async () => {
  const committed = Promise.withResolvers<string>();
  const app = await suite.boot({
    config: suite.config("session-fork-", { wsToken: "fork-token" }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "done" }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind === "turn") committed.resolve(event.sessionId);
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fork-token"]);
  const terminal = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "first" }));
  const sessionId = await bounded(committed.promise);
  await terminal;

  const kernel = plane.openKernel(sessionId);
  const actions = kernel.historyPage(sessionId, { afterRevision: 0, limit: 256 }).actions;
  const anchor = [...actions].reverse().find((action) => {
    const effect = action.effect.value;
    return action.kind === "turn" && effect !== null && typeof effect === "object" &&
      !Array.isArray(effect) && effect.phase === "terminal";
  });
  if (anchor === undefined) throw new Error("no terminal anchor in parent history");

  // A bogus anchor is a typed refusal, never a dropped frame.
  const refusedFrame = nextFrame(socket, (frame) => frame.type === "session_fork_refused");
  socket.send(JSON.stringify({ type: "session_fork", sessionId, at: "no-such-hash" }));
  expect(await refusedFrame).toMatchObject({
    type: "session_fork_refused",
    sessionId,
    reason: "anchor_not_found",
  });

  const forkedFrame = nextFrame(socket, (frame) => frame.type === "session_forked");
  socket.send(JSON.stringify({
    type: "session_fork", sessionId, at: anchor.actionHash, childId: "forked-child",
  }));
  const forked = await forkedFrame;
  expect(forked).toMatchObject({
    type: "session_forked",
    sessionId: "forked-child",
    parentId: sessionId,
  });
  const forkedFrom = forked.forkedFrom;
  if (forkedFrom === null || typeof forkedFrom !== "object" || Array.isArray(forkedFrom))
    throw new Error("session_forked carried no fork pin");
  expect(forkedFrom.session).toBe(sessionId);
  expect(forkedFrom.anchor).toBe(anchor.actionHash);

  // The child's read page projects the ancestry and the history-only aside.
  const childPage = nextFrame(socket, (frame) => frame.type === "session_snapshot");
  socket.send(JSON.stringify({ type: "session_read", sessionId: "forked-child", limit: 256 }));
  const page = await childPage;
  const ancestry = page.ancestry;
  if (ancestry === null || typeof ancestry !== "object" || Array.isArray(ancestry))
    throw new Error("child page carried no ancestry");
  expect(ancestry.parentId).toBe(sessionId);
  expect(typeof ancestry.aside).toBe("string");
  expect(String(ancestry.aside)).toContain(sessionId);
  // The parent's own page projects a bare ancestry: no pin, no aside.
  const parentPage = nextFrame(socket, (frame) =>
    frame.type === "session_snapshot" && frame.sessionId === sessionId);
  socket.send(JSON.stringify({ type: "session_read", sessionId, limit: 256 }));
  const parent = await parentPage;
  expect(parent.ancestry).toMatchObject({ forkedFrom: null, aside: null });
  await closeSocket(socket);
});

/**
 * Generation-configured copy cap (#1257 M-5): the composition root's
 * `forkCopyByteCap` threads through the SHIPPED gateway fork path. An
 * override smaller than the parent's copied bytes turns the same
 * otherwise-valid boundary fork into the typed `byte_cap` refusal.
 */
test("session_fork refuses an over-limit copy under a configured byte cap", async () => {
  const committed = Promise.withResolvers<string>();
  const app = await suite.boot({
    // 16 bytes: far below any real chain's copied intent/effect payloads.
    config: suite.config("session-fork-cap-", { wsToken: "fork-token", forkCopyByteCap: 16 }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "done" }));
        return { type: "stop" as const };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind === "turn") committed.resolve(event.sessionId);
  });
  suite.defer(unsubscribe);
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fork-token"]);
  const terminal = nextResidentTurn(plane);
  socket.send(JSON.stringify({ type: "message", eventId: newTraceId(), text: "first" }));
  const sessionId = await bounded(committed.promise);
  await terminal;

  const kernel = plane.openKernel(sessionId);
  const actions = kernel.historyPage(sessionId, { afterRevision: 0, limit: 256 }).actions;
  const anchor = [...actions].reverse().find((action) => {
    const effect = action.effect.value;
    return action.kind === "turn" && effect !== null && typeof effect === "object" &&
      !Array.isArray(effect) && effect.phase === "terminal";
  });
  if (anchor === undefined) throw new Error("no terminal anchor in parent history");

  const refusedFrame = nextFrame(socket, (frame) => frame.type === "session_fork_refused");
  socket.send(JSON.stringify({
    type: "session_fork", sessionId, at: anchor.actionHash, childId: "capped-child",
  }));
  expect(await refusedFrame).toMatchObject({
    type: "session_fork_refused",
    sessionId,
    reason: "byte_cap",
  });
  // The refusal materialized no child: the catalog has no such session.
  expect(plane.catalog.sessionIndex("capped-child")).toBeUndefined();
  await closeSocket(socket);
});

/**
 * Fail-closed legacy handling (#1257 H-1): a parent file on an old
 * schemaVersion is refused by the read-only `PRAGMA user_version` probe
 * BEFORE anything opens it for write — no stamp, no WAL, bytes identical.
 */
test("session_fork refuses a legacy parent file without touching its bytes", async () => {
  const config = suite.config("session-fork-legacy-", { wsToken: "fork-token" });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "done" }));
        return { type: "stop" as const };
      }),
    },
  });
  if (config.sessionsDir === undefined) throw new Error("fixture config has no sessionsDir");
  mkdirSync(config.sessionsDir, { recursive: true });
  // A legacy session file: real tables, but no schemaVersion marker (0 ≠ 1).
  const legacyPath = join(config.sessionsDir, "legacy-parent.sqlite");
  const legacy = new Database(legacyPath);
  legacy.run("CREATE TABLE legacy_actions (id TEXT PRIMARY KEY, payload TEXT)");
  legacy.run("INSERT INTO legacy_actions VALUES ('a-1', 'old-world row')");
  legacy.close();
  const sha256 = () => createHash("sha256").update(readFileSync(legacyPath)).digest("hex");
  const before = sha256();

  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fork-token"]);
  const refusedFrame = nextFrame(socket, (frame) => frame.type === "session_fork_refused");
  socket.send(JSON.stringify({ type: "session_fork", sessionId: "legacy-parent", at: "any-hash" }));
  expect(await refusedFrame).toMatchObject({
    type: "session_fork_refused",
    sessionId: "legacy-parent",
    reason: "schema_version",
  });

  // Zero writes: bytes identical, no stamp, and no WAL/SHM ever appeared.
  expect(sha256()).toBe(before);
  expect(existsSync(`${legacyPath}-wal`)).toBeFalse();
  expect(existsSync(`${legacyPath}-shm`)).toBeFalse();
  await closeSocket(socket);
});
