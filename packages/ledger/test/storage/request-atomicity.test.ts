import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { L0Observation } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { tempDbPath, removeSqliteFiles } from "../helpers/sqlite";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";

let path: string;
beforeEach(() => {
  path = tempDbPath("request-atomicity");
  Storage.initialize({ dbPath: path });
});
afterEach(() => {
  Storage.reset();
  removeSqliteFiles(path);
});

test("failed request insert rolls back original action, revision and observation", () => {
  const { request, original, commit } = requestFixture();
  using raw = new Database(path);
  raw.run(`CREATE TRIGGER refuse_request BEFORE INSERT ON action WHEN NEW.kind = 'request'
    BEGIN SELECT RAISE(ABORT, 'request write failed'); END`);
  const before = SessionHandleStore.row(request.sessionId);
  const tree = SessionHandleStore.tree(request.sessionId);
  expect(() => commit([original, requestStateAction(request)])).toThrow("request write failed");
  expect(SessionHandleStore.row(request.sessionId)).toEqual(before);
  expect(SessionHandleStore.tree(request.sessionId)).toEqual(tree);
  expect(SessionHandleStore.requestRows()).toEqual([]);
});

test("request commit requires the live lease rather than borrowing another owner's fence", () => {
  const { request, original, commit } = requestFixture();
  expectCommitted(commit([original, requestStateAction(request)]));
  const before = SessionHandleStore.tree(request.sessionId);
  const result = SessionHandleStore.commitRequestTransition({
    sessionId: request.sessionId,
    owner: "foreign",
    fence: 1,
    now: 5,
    expectedRevision: SessionHandleStore.row(request.sessionId).revision,
    actions: [requestStateAction(request, "foreign")],
    consumeInboxIds: [],
    state: "idle",
    releaseLease: false,
  });
  expect(result).toMatchObject({ ok: false, reason: "stale" });
  expect(SessionHandleStore.tree(request.sessionId)).toEqual(before);
});

test("commit observations see durable request state after the complete batch", () => {
  Storage.reset();
  const seen: string[] = [];
  Storage.initialize({
    dbPath: path,
    observationSink: {
      publish(event, data) {
        if (event.name !== L0Observation.ActionCommittedEvent.name) return;
        const receipt = L0Observation.ActionCommitted.parse(data);
        if (receipt.sessionId !== "request-session" || receipt.revision < 3) return;
        expect(SessionHandleStore.requestById("original")?.state).toBe("open");
        seen.push(receipt.sessionId);
      },
    },
  });
  const { request, original, commit } = requestFixture();
  expectCommitted(commit([original, requestStateAction(request)]));
  expect(seen.length).toBeGreaterThan(0);
});
