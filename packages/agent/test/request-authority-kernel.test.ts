import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Inbox, type SessionTransition } from "@openomni/protocol";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { allowConfigure, isolatedRuntime } from "./helpers/session-services";
import { openRequest } from "./helpers/open-request";
import { requestLedger } from "./helpers/g0-request-ledger";
import { commitSessionRequest, requestAuthorityKernel } from "../src/session-admission";
import { adoptSessionAuthority } from "../src/session-configuration";
import { sessionTree } from "./helpers/session-tree";

/**
 * W5.2 #1197 S1/S2 regressions: the boot request port borrows a live
 * activation's fence (`requestAuthorityKernel`), and child-session admissions
 * never ride the sender's single-session fenced batch.
 */

function runtime() {
  return { authorizeConfigure: allowConfigure, ...isolatedRuntime() };
}

/** One recorded tool invocation the request reopens (mirrors request-count-admission). */
function pending(id: string) {
  return Effect.gen(function* () {
    const fixture = yield* requestLedger({ id });
    const { identity } = fixture;
    const request = openRequest({
      requestId: `${id}:original`,
      sessionId: id,
      turnId: identity.turnId,
      callId: `${id}:call`,
      parsedInput: { path: id },
      toolsGeneration: identity.toolsGeneration,
      toolsHash: identity.toolsHash,
      systemHash: identity.systemHash,
      deadline: 1000,
      createdAt: 100,
    });
    yield* fixture.ledger.commit({
      id: request.requestId,
      parentId: identity.parentActionId,
      sessionId: id,
      kind: "tool",
      intent: {
        encodingVersion: 1,
        value: { phase: "intent", value: request.parsedInput, effectHash: request.effectHash },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      irreversible: true,
      ts: 100,
    });
    return request;
  });
}

// S1: the borrowed-fence caller's decision must run under the true live owner.
test("a borrowed-fence caller opens a request mid-turn under the live owner", () =>
  isolated(
    Effect.gen(function* () {
      const id = "borrow-live";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const liveOwner = `${id}:owner`;
      expect(kernel.row(id)).toMatchObject({ state: "running", leaseOwner: liveOwner, leaseFence: 1 });
      const wrapped = requestAuthorityKernel(kernel, id);
      const caller = "pid:request:borrower";
      const fence = yield* adoptSessionAuthority(wrapped, id, caller);
      // Borrowing never rotates the fence or steals the row.
      expect(fence).toBe(1);
      expect(kernel.row(id)).toMatchObject({ leaseOwner: liveOwner, leaseFence: 1 });
      const decision = yield* commitSessionRequest(
        wrapped,
        id,
        { owner: caller, fence },
        { kind: "request.open", request },
        `${request.requestId}:open`,
        100,
        runtime(),
      );
      expect(decision.resolution).toBe("opened");
      expect(
        kernel.requestRows(id).map((row: SessionTransition.Request) => row.requestId),
      ).toEqual([request.requestId]);
      // The durable row still belongs to the live activation.
      expect(kernel.row(id)).toMatchObject({ leaseOwner: liveOwner, leaseFence: 1 });
    }),
  ));

// S1 fail-closed: authority not adopted through the borrowing view stays refused.
test("an unrelated owner is still refused mid-turn", () =>
  isolated(
    Effect.gen(function* () {
      const id = "borrow-foreign";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const before = sessionTree(kernel, id);
      const decision = yield* commitSessionRequest(
        requestAuthorityKernel(kernel, id),
        id,
        { owner: "pid:request:intruder", fence: 1 },
        { kind: "request.open", request },
        `${request.requestId}:open`,
        100,
        runtime(),
      );
      expect(decision.resolution).toBe("rejected");
      expect(decision.actions).toEqual([]);
      expect(kernel.requestRows(id)).toEqual([]);
      expect(sessionTree(kernel, id)).toEqual(before);
    }),
  ));

// S1 fallback: an idle session keeps the documented out-of-turn takeover.
test("an idle session falls back to a real fence adoption", () =>
  isolated(
    Effect.gen(function* () {
      const kernel = isolatedLedger().kernel;
      const id = "borrow-idle";
      yield* kernel.materialize({
        id,
        role: "resident",
        parentId: null,
        policyGeneration: 1,
        tools: [],
        system: { preset: "", blocks: [] },
        actionId: `${id}:configure`,
        at: 100,
      });
      const caller = "pid:request:idle-taker";
      const fence = yield* adoptSessionAuthority(requestAuthorityKernel(kernel, id), id, caller);
      expect(fence).toBe(1);
      expect(kernel.row(id)).toMatchObject({ leaseOwner: caller, leaseFence: 1 });
    }),
  ));

// S2: a `new_session` child's admission must not ride the sender's fenced batch.
test("a foreign-session admission does not ride the sender's batch", () =>
  isolated(
    Effect.gen(function* () {
      const id = "sender-session";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const admission = Inbox.Commit.parse({
        id: "child:msg-1",
        sessionId: "child-session",
        kind: "prompt",
        content: "work",
        origin: { encodingVersion: 1, value: { kind: "session", sessionId: id } },
        createdAt: 100,
        parentActionId: null,
      });
      const decision = yield* commitSessionRequest(
        kernel,
        id,
        { owner: `${id}:owner`, fence: 1 },
        { kind: "request.open", request },
        `${request.requestId}:open`,
        100,
        runtime(),
        admission,
      );
      // Before the fix the whole batch was refused (CommitRefused "revision").
      expect(decision.resolution).toBe("opened");
      expect(
        kernel.requestRows(id).map((row: SessionTransition.Request) => row.requestId),
      ).toEqual([request.requestId]);
      // The child's admission is not in the sender's chain: its own entity commits it.
      expect(kernel.actionById("child:msg-1")).toBeUndefined();
    }),
  ));

// S2 guard: a same-session admission still rides the fenced batch.
test("a same-session admission still rides the sender's batch", () =>
  isolated(
    Effect.gen(function* () {
      const id = "sender-local";
      const request = yield* pending(id);
      const kernel = isolatedLedger().kernel;
      const admission = Inbox.Commit.parse({
        id: `${id}:msg-1`,
        sessionId: id,
        kind: "prompt",
        content: "local intake",
        origin: { encodingVersion: 1, value: { kind: "session", sessionId: id } },
        createdAt: 100,
        parentActionId: null,
      });
      const decision = yield* commitSessionRequest(
        kernel,
        id,
        { owner: `${id}:owner`, fence: 1 },
        { kind: "request.open", request },
        `${request.requestId}:open`,
        100,
        runtime(),
        admission,
      );
      expect(decision.resolution).toBe("opened");
      const intake = kernel.actionById(`${id}:msg-1`);
      expect(intake).toMatchObject({ sessionId: id, kind: "prompt" });
    }),
  ));
