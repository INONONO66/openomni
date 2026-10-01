import { expect, test } from "bun:test";
import { requireCommit } from "../src/session-record";
import { SessionCommitError } from "../src/session-contract";

// A refused commit must surface the ledger's verdict verbatim: callers branch
// on `result.reason` (stale vs revision) to decide retry-versus-abort.
test("requireCommit wraps a refused commit in SessionCommitError with the verdict attached", () => {
  const refused = {
    ok: false,
    reason: "stale",
    currentFence: 4,
    currentRevision: 7,
  } as const;
  const call = () => requireCommit(refused);
  expect(call).toThrow(SessionCommitError);
  expect(call).toThrow("session commit stale");
  const error = new SessionCommitError(refused);
  expect(error.name).toBe("SessionCommitError");
  expect(error.result).toEqual(refused);
});
