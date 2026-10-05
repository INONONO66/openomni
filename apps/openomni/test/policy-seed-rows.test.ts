import { expect, test } from "bun:test";
import type { Bundle } from "@openomni/agent";
import { gateRowPolicySeeds } from "../src/policy-seed";

const row = (over: Partial<Bundle.BundleGateRow>): Bundle.BundleGateRow => ({
  id: "probe/tool.pre#1",
  on: "tool.pre",
  when: { op: "monitor" },
  do: "gate",
  how: {},
  order: 7,
  ...over,
});

test("gate rows project onto the legacy seed shape: obligation, constant verdicts and transforms", () => {
  const seeds = gateRowPolicySeeds([
    row({ how: { ref: "kernel/budget-clamp", metric: "notifications", limit: 8 } }),
    row({ id: "probe/tool.pre#2", how: {} }),
    row({ id: "probe/tool.pre#3", how: { verdict: "require_approval" } }),
    row({ id: "probe/tool.pre#4", do: "rewrite", how: { ref: "probe/redact" } }),
    row({ id: "probe/tool.pre#5", do: "rewrite", how: { ref: "probe/redact", params: { keys: ["token"] } } }),
    row({ id: "probe/alarm.fired#1", on: "alarm.fired", when: {}, how: { verdict: "deny" } }),
  ]);
  expect(seeds.map((seed) => [seed.name, seed.kind, seed.phase, seed.priority])).toEqual([
    ["probe/tool.pre#1", "tool", "pre", 7],
    ["probe/tool.pre#2", "tool", "pre", 7],
    ["probe/tool.pre#3", "tool", "pre", 7],
    ["probe/tool.pre#4", "tool", "pre", 7],
    ["probe/tool.pre#5", "tool", "pre", 7],
    ["probe/alarm.fired#1", "alarm.fired", "post", 7],
  ]);
  expect(seeds.map((seed) => seed.verdict.value)).toEqual([
    { type: "obligation", ref: "kernel/budget-clamp", metric: "notifications", limit: 8 },
    { type: "allow" },
    { type: "require_approval", reason: "probe/tool.pre#3" },
    { type: "transform", ref: "probe/redact" },
    { type: "transform", ref: "probe/redact", config: { keys: ["token"] } },
    { type: "deny" },
  ]);
  expect(seeds[0]?.match).toEqual({ encodingVersion: 1, value: { op: "monitor" } });
});

test("a consulted gate row without budget fields seeds as a guard verdict (#1258)", () => {
  const seeds = gateRowPolicySeeds([
    row({ how: { ref: "delegation-policy/spawn-depth", params: { limit: 3 } } }),
  ]);
  expect(seeds[0]?.verdict.value).toEqual({
    type: "guard",
    ref: "delegation-policy/spawn-depth",
    config: { limit: 3 },
  });
});

test("a row the live plane cannot seed is an invariant failure, never a silent default", () => {
  expect(() => gateRowPolicySeeds([row({ do: "emit", how: { emit: "message" } })])).toThrow(
    "has no live policy-plane seed shape",
  );
  expect(() => gateRowPolicySeeds([row({ on: "ghost.pre" as Bundle.BundleGateRow["on"] })])).toThrow(
    "has no legacy policy address",
  );
});
