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

function kernelFixture(): Core.SessionKernel {
  const directory = mkdtempSync(join(tmpdir(), "openomni-composition-"));
  directories.push(directory);
  const now = testClock();
  const catalog = Core.openCatalogStore(join(directory, "catalog.sqlite"), { now });
  const session = Core.openSessionStore(join(directory, "session.sqlite"), { now });
  return Core.SessionHandleStore.createSessionKernel(session, catalog);
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

test("#1276 drift: pinnedModelSelection — real and mirror agree on a kernel without prior attempts", () => {
  const kernel = kernelFixture();
  const row = materializeSession(kernel, "drift-session");
  const real = pinnedModelSelection(kernel, row.id, "turn-1");
  expect(real).toBeUndefined();
  expect(mirror.pinnedModelSelection(kernel, row.id, "turn-1")).toBe(real);
});

test("#1276 drift: parentReply — real and mirror agree on the decision table", () => {
  const kernel = kernelFixture();
  const root = materializeSession(kernel, "drift-parent");
  const child = materializeSession(kernel, "drift-child", "drift-parent");
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
  const results: readonly Core.SessionRunnerResult[] = [
    { kind: "waiting", reason: "live_wait", alarmIds: [], text: "" },
    { kind: "result", text: "done" },
  ];
  for (const result of results) {
    for (const row of [root, child]) {
      const real = parentReply(kernel, row, terminal, result);
      // Root rows and waiting results reply nothing; the child has no received
      // parent message in this fixture, so every cell is undefined — the point
      // is both implementations fold the same decision.
      expect(real).toBeUndefined();
      expect(mirror.parentReply(kernel, row, terminal, result)).toBe(real);
    }
  }
});
