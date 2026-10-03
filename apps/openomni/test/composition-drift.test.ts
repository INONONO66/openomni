/**
 * #1276 drift guard: packages/agent/test/helpers/composition-fixtures.ts
 * hand-syncs mirrors of the app compositions (the agent package may not
 * import apps/openomni, so core tests inject the mirrors). This suite drives
 * the REAL implementations and the mirrors with identical inputs and asserts
 * identical outputs, so either side changing alone fails here until both move
 * together. #1258 replaces parent-reply with the contact contract.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Core } from "@openomni/agent";
import type { LedgerAction, Model } from "@openomni/protocol";
import { Effect } from "effect";
import { parentReply } from "../src/composition/parent-reply";
import { pinnedModelSelection, restoreModelSelection } from "../src/composition/model-selection";
import * as mirror from "../../../packages/agent/test/helpers/composition-fixtures";
import { materializeSession } from "../../../packages/agent/test/store/helpers/session";
import { runEffect } from "./helpers/effect";
import { testClock } from "./helpers/test-entropy";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface StoreFixture {
  readonly kernel: Core.SessionKernel;
  readonly session: ReturnType<typeof Core.openSessionStore>;
}

function kernelFixture(): StoreFixture {
  const directory = mkdtempSync(join(tmpdir(), "openomni-composition-"));
  directories.push(directory);
  const now = testClock();
  const catalog = Core.openCatalogStore(join(directory, "catalog.sqlite"), { now });
  const session = Core.openSessionStore(join(directory, "session.sqlite"), { now });
  return { session, kernel: Core.SessionHandleStore.createSessionKernel(session, catalog) };
}

function appendAction(fixture: StoreFixture, action: LedgerAction.Append): void {
  const receipt = fixture.session.actions.append(
    action,
    fixture.kernel.row(action.sessionId).revision,
  );
  if (receipt === undefined) throw new Error(`append refused: ${action.id}`);
}

type RunArguments = Parameters<Core.Executor["run"]>[0];

function stubExecutor(terminal: "executed" | "blocked_pre") {
  const requests: RunArguments[] = [];
  const executor: Pick<Core.Executor, "run"> = {
    run: (request) => {
      requests.push(request);
      return Effect.succeed(
        terminal === "executed"
          ? { terminal: "executed" as const, value: { restored: true } }
          : { terminal: "blocked_pre" as const, reason: "policy refused" },
      );
    },
  };
  return { executor, requests };
}

const CHAIN: readonly Model.Ref[] = [
  { provider: "anthropic", id: "primary" },
  { provider: "anthropic", id: "fallback-1" },
  { provider: "openai", id: "fallback-2" },
];

test("#1276 drift: restoreModelSelection — real and mirror agree on every branch", async () => {
  const cases: readonly {
    readonly pinned: Model.Ref | undefined;
    readonly outcome: "executed" | "blocked_pre";
    readonly expected: number;
    readonly consults: number;
  }[] = [
    { pinned: undefined, outcome: "executed", expected: 0, consults: 0 },
    { pinned: CHAIN[0], outcome: "executed", expected: 0, consults: 0 },
    { pinned: { provider: "openai", id: "absent" }, outcome: "executed", expected: 0, consults: 0 },
    { pinned: CHAIN[2], outcome: "executed", expected: 0, consults: 1 },
    { pinned: CHAIN[2], outcome: "blocked_pre", expected: 2, consults: 1 },
  ];
  for (const item of cases) {
    const real = stubExecutor(item.outcome);
    const mirrored = stubExecutor(item.outcome);
    const realIndex = await runEffect(restoreModelSelection(real.executor, item.pinned, CHAIN));
    const mirrorIndex = await runEffect(
      mirror.restoreModelSelection(mirrored.executor, item.pinned, CHAIN),
    );
    expect(realIndex).toBe(item.expected);
    expect(mirrorIndex).toBe(realIndex);
    expect(real.requests).toHaveLength(item.consults);
    expect(mirrored.requests).toEqual(real.requests);
  }
});

test("#1276 drift: pinnedModelSelection — real and mirror read back the recorded prior attempt", () => {
  const fixture = kernelFixture();
  const row = materializeSession(fixture.kernel, "drift-session");
  // No prior attempt: both sides answer undefined.
  expect(pinnedModelSelection(fixture.kernel, row.id, "turn-1")).toBeUndefined();
  expect(mirror.pinnedModelSelection(fixture.kernel, row.id, "turn-1")).toBeUndefined();
  // An earlier turn's chat attempt pinned a fallback.
  appendAction(fixture, {
    id: "pin-llm",
    parentId: `${row.id}:configure`,
    sessionId: row.id,
    kind: "llm",
    intent: { encodingVersion: 1, value: { phase: "intent" } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts: 2,
  });
  appendAction(fixture, {
    id: "pin-attempt",
    parentId: "pin-llm",
    sessionId: row.id,
    kind: "attempt",
    intent: {
      encodingVersion: 1,
      value: { phase: "intent", op: "chat", value: { provider: "anthropic", model: "fallback-1" } },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts: 3,
  });
  const real = pinnedModelSelection(fixture.kernel, row.id, "turn-1");
  expect(real).toEqual({ provider: "anthropic", id: "fallback-1" });
  expect(mirror.pinnedModelSelection(fixture.kernel, row.id, "turn-1")).toEqual(real);
});

test("#1276 drift: parentReply — real and mirror agree on the decision table", () => {
  const fixture = kernelFixture();
  const kernel = fixture.kernel;
  const root = materializeSession(kernel, "drift-parent");
  const child = materializeSession(kernel, "drift-child", "drift-parent");
  // The child received one message from its parent; a terminal run replies to it.
  appendAction(
    fixture,
    Core.receivedMessageAction({
      id: "drift-child:received-1",
      sessionId: child.id,
      kind: "prompt",
      content: "do the work",
      origin: {
        encodingVersion: 1,
        value: {
          kind: "message",
          messageId: "m-1",
          senderSessionId: root.id,
          replyTo: "m-0",
          sourceActionId: "parent-req-1",
        },
      },
      parentActionId: `${child.id}:configure`,
      at: 5,
    }),
  );
  const terminal: LedgerAction.Append = {
    id: "drift-child:turn-1:seal",
    parentId: null,
    sessionId: child.id,
    kind: "turn",
    intent: { encodingVersion: 1, value: { kind: "seal" } },
    effect: { encodingVersion: 1, value: null },
    ts: testClock()(),
    irreversible: true,
  };
  const cases: readonly {
    readonly result: Core.SessionRunnerResult;
    readonly expected: { readonly terminal: "completed" | "interrupted"; readonly content: string } | undefined;
  }[] = [
    { result: { kind: "waiting", reason: "live_wait", alarmIds: [], text: "" }, expected: undefined },
    { result: { kind: "result", text: "done" }, expected: { terminal: "completed", content: "done" } },
    { result: { kind: "interrupted" }, expected: { terminal: "interrupted", content: "" } },
  ];
  for (const item of cases) {
    // A root row replies nothing regardless of the result kind.
    expect(parentReply(kernel, root, terminal, item.result)).toBeUndefined();
    expect(mirror.parentReply(kernel, root, terminal, item.result)).toBeUndefined();
    const real = parentReply(kernel, child, terminal, item.result);
    if (item.expected === undefined) {
      expect(real).toBeUndefined();
    } else {
      // Correlation and terminal fields come from the received origin + seal.
      expect(real).toMatchObject({
        messageId: `${terminal.id}:reply`,
        sourceSessionId: child.id,
        sourceActionId: terminal.id,
        destinationSessionId: root.id,
        requestId: "parent-req-1",
        replyTo: "m-0",
        terminal: item.expected.terminal,
        content: item.expected.content,
      });
    }
    expect(mirror.parentReply(kernel, child, terminal, item.result)).toEqual(real);
  }
});
