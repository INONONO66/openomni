/**
 * #1258 delegation-policy bundle: the three cap guards at `tool.pre`
 * (spawn_depth from catalog parent links, spawn_children from the parent's
 * live-children count, spend-cap refusal when unset) and the
 * `delegation.deadline` purpose (cancel the silent child, prompt the parent).
 * Exact-state assertions; connectors and guards are pure or injected-door
 * programs, so no clock is involved beyond the fired occurrence's own stamp.
 */
import { expect, test } from "bun:test";
import type { Bundle } from "@openomni/agent";
import { Effect } from "effect";
import {
  catalogDelegationReads,
  DEFAULT_DELEGATION_CAPS,
  DELEGATION_DEADLINE,
  delegationPolicyBundle,
  delegationPurposes,
  delegationRows,
  spawnChildrenGuard,
  spawnDepthGuard,
  spendCapGuard,
  type DelegationReads,
} from "../src/bundles/delegation-policy";
import { runEffect } from "./helpers/effect";

const NEW_SESSION = { to: { kind: "new_session", role: "worker" }, message: "go" };
const service = () => {
  throw new Error("guards consult no services");
};
const when = { op: "send_message", sessionId: "parent" };

function reads(input: { depth?: number; children?: number }): DelegationReads {
  return {
    depth: () => input.depth,
    activeChildren: () => input.children,
  };
}

test("spawn_depth allows below the row limit and denies at it; a non-child send is skipped", () => {
  const guard = spawnDepthGuard(reads({ depth: 2 }));
  expect(guard.decide({ value: NEW_SESSION, params: { limit: 3 }, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_depth", limit: 3, observed: 2 },
  });
  expect(spawnDepthGuard(reads({ depth: 3 })).decide({ value: NEW_SESSION, params: { limit: 3 }, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spawn_depth", limit: 3, observed: 3 },
  });
  expect(guard.decide({ value: { to: { kind: "session", id: "s" }, message: "hi" }, params: { limit: 3 }, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_depth", skipped: true },
  });
});

test("caps fail closed: an unknown session or a missing sessionId denies child creation", () => {
  const unavailable = spawnDepthGuard(reads({}));
  expect(unavailable.decide({ value: NEW_SESSION, params: { limit: 3 }, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spawn_depth", limit: 3, reason: "catalog read unavailable" },
  });
  expect(
    spawnChildrenGuard(reads({ children: 1 })).decide({ value: NEW_SESSION, params: null, when: { op: "send_message" }, service }),
  ).toEqual({
    verdict: "deny",
    payload: { cap: "spawn_children", limit: DEFAULT_DELEGATION_CAPS.maxActiveChildren, reason: "catalog read unavailable" },
  });
});

test("spawn_children denies the fifth concurrent child under the default cap", () => {
  const atCap = spawnChildrenGuard(reads({ children: 4 }));
  expect(atCap.decide({ value: NEW_SESSION, params: { limit: 4 }, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spawn_children", limit: 4, observed: 4 },
  });
  expect(spawnChildrenGuard(reads({ children: 3 })).decide({ value: NEW_SESSION, params: { limit: 4 }, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_children", limit: 4, observed: 3 },
  });
});

test("spend cap: a new session without a positive spend_cap is refused", () => {
  const guard = spendCapGuard();
  expect(guard.decide({ value: NEW_SESSION, params: null, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spend_cap", reason: "new session requires spend_cap" },
  });
  expect(guard.decide({ value: { ...NEW_SESSION, spend_cap: 0 }, params: null, when, service })).toEqual({
    verdict: "deny",
    payload: { cap: "spend_cap", reason: "new session requires spend_cap" },
  });
  expect(guard.decide({ value: { ...NEW_SESSION, spend_cap: 2.5 }, params: null, when, service })).toEqual({
    verdict: "allow",
    payload: { cap: "spend_cap", granted: 2.5 },
  });
});

test("catalog reads: depth walks parent links, activeChildren counts live rows, absent session is undefined", () => {
  const rows = [
    { id: "root", parentId: null },
    { id: "mid", parentId: "root" },
    { id: "leaf", parentId: "mid" },
    { id: "leaf2", parentId: "mid" },
  ];
  const catalog = catalogDelegationReads(() => rows);
  expect(catalog.depth("root")).toBe(0);
  expect(catalog.depth("leaf")).toBe(2);
  expect(catalog.depth("ghost")).toBeUndefined();
  expect(catalog.activeChildren("mid")).toBe(2);
  expect(catalog.activeChildren("leaf")).toBe(0);
  expect(catalog.activeChildren("ghost")).toBeUndefined();
});

test("a finished child frees a spawn_children slot; a liveness read failure counts the child", () => {
  const rows = [
    { id: "parent", parentId: null },
    ...["a", "b", "c", "d"].map((id) => ({ id, parentId: "parent" })),
  ];
  const finished = new Set<string>();
  const catalog = catalogDelegationReads(
    () => rows,
    (childId) => {
      if (childId === "d") throw new Error("session store unreachable");
      return !finished.has(childId);
    },
  );
  const guard = spawnChildrenGuard(catalog);
  const decide = () =>
    guard.decide({ value: NEW_SESSION, params: null, when, service });
  // Four active children exhaust the cap.
  expect(decide()).toEqual({
    verdict: "deny",
    payload: { cap: "spawn_children", limit: 4, observed: 4 },
  });
  // One child finishes -> the next request succeeds (issue edge case).
  finished.add("a");
  expect(decide()).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_children", limit: 4, observed: 3 },
  });
  // An unreadable child stays counted (conservative, cap stays tight).
  finished.add("b");
  finished.add("d");
  expect(decide()).toEqual({
    verdict: "allow",
    payload: { cap: "spawn_children", limit: 4, observed: 2 },
  });
});

test("the bundle contract carries the three tool.pre rows, their guards, and the deadline purpose", () => {
  const bundle = delegationPolicyBundle();
  expect(bundle.requires.map((seam) => seam.key)).toEqual([
    "@openomni/action/Action",
    "@openomni/agent/capability/alarm",
    "@openomni/openomni/ToolCapabilitySeam",
  ]);
  expect(delegationRows().map((row) => [row.on, row.how.ref])).toEqual([
    ["tool.pre", "delegation-policy/spawn-depth"],
    ["tool.pre", "delegation-policy/spawn-children"],
    ["tool.pre", "delegation-policy/spend-cap"],
  ]);
  expect(delegationRows().every((row) => row.when.op === "send_message")).toBe(true);
  expect(Object.keys(bundle.handlers)).toEqual([
    "delegation-policy/spawn-depth",
    "delegation-policy/spawn-children",
    "delegation-policy/spend-cap",
  ]);
  expect(Object.keys(bundle.purposes)).toEqual([DELEGATION_DEADLINE]);
});

// ─── delegation.deadline wake ───

function fired(payload: string): Bundle.AlarmFired {
  return {
    occurrenceId: "alarm-1:1:deadline",
    purpose: DELEGATION_DEADLINE,
    alarmId: "alarm-1",
    armSeq: 1,
    sourceKey: "delegation:child-1",
    payload,
    fireAt: 5_000,
  };
}

function wakeContext(prompts: { content: string }[]): Bundle.AlarmPurposeHandler extends never
  ? never
  : Parameters<Bundle.AlarmPurposeHandler>[0]["ctx"] {
  return {
    sessionId: "parent",
    now: 5_000,
    reads: {
      latestArm: () => undefined,
      settled: () => false,
    },
    arm: () => Effect.die(new Error("deadline wake re-arms nothing")),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push({ content: input.content });
        return { seq: prompts.length };
      }),
  };
}

test("deadline fire cancels the silent child through the injected door and prompts the parent", async () => {
  const cancelled: { child: string; occurrenceId: string }[] = [];
  const prompts: { content: string }[] = [];
  const handler = delegationPurposes({
    cancel: (input) => Effect.sync(() => void cancelled.push(input)),
  }).purposes[0]?.handler;
  if (handler === undefined) throw new Error("deadline purpose missing");
  const outcome = await runEffect(
    handler({
      fired: fired(JSON.stringify({ child: "child-1", contact: "session:child-1" })),
      ctx: wakeContext(prompts),
    }),
  );
  expect(outcome).toBe("delivered");
  expect(cancelled).toEqual([{ child: "child-1", occurrenceId: "alarm-1:1:deadline" }]);
  expect(prompts).toHaveLength(1);
  expect(JSON.parse(prompts[0]?.content ?? "")).toEqual({
    kind: DELEGATION_DEADLINE,
    contact: "session:child-1",
    child: "child-1",
    firedAt: 5_000,
    note: "deadline expired with no reply; the child was cancelled",
  });
});

test("a malformed payload or a refused cancel is the typed wake failure, never a silent success", async () => {
  const handler = delegationPurposes({
    cancel: () => Effect.fail({ reason: "entity door refused" }),
  }).purposes[0]?.handler;
  if (handler === undefined) throw new Error("deadline purpose missing");
  const prompts: { content: string }[] = [];
  await expect(
    runEffect(handler({ fired: fired("not json"), ctx: wakeContext(prompts) })),
  ).rejects.toMatchObject({ reason: "payload" });
  await expect(
    runEffect(
      handler({
        fired: fired(JSON.stringify({ child: "child-1", contact: "session:child-1" })),
        ctx: wakeContext(prompts),
      }),
    ),
  ).rejects.toMatchObject({ reason: "entity door refused" });
  expect(prompts).toEqual([]);
});
