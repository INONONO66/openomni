import { expect, test } from "bun:test";
import { createPolicyCompiler, KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS } from "@openomni/agent";
import type { PolicyRow } from "@openomni/protocol";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { MESSAGE_POLICY_ROWS } from "../src/message-policy";
import { PROVISION_POLICY_ROWS } from "../src/tools/provision";
import { testPlane } from "./helpers/ledger";

test("the ledger writer seeds generation one with mandatory rows and identical reseeding is a no-op", () => {
  const source = testPlane().catalog.policies;
  expect(seedKernelPolicyRows(source)).toBe(1);
  const first = source.rows();
  for (const row of [...SEEDED_POLICY_ROWS, ...MESSAGE_POLICY_ROWS, ...PROVISION_POLICY_ROWS]) {
    expect(first).toContainEqual({ ...row, generation: 1 });
  }
  expect(first.find((row: PolicyRow.Row) => row.name === "monitor-wake-budget"))
    .toMatchObject({ generation: 1, verdict: { value: { ref: "kernel/budget-clamp" } } });
  expect(seedKernelPolicyRows(source)).toBe(1);
  expect(source.rows()).toEqual(first);
  expect(source.rows(2)).toEqual([]);
});

test("an unresolved named ref in a ledger generation compiles to a typed deny", () => {
  const source = testPlane().catalog.policies;
  const generation = seedKernelPolicyRows(source, [{
    name: "missing-ref", kind: "tool", phase: "pre", priority: 1000,
    match: { encodingVersion: 1, value: { op: "provision" } },
    verdict: { encodingVersion: 1, value: { type: "transform", ref: "app/not-registered" } },
  }]);
  const compiler = createPolicyCompiler({ source, registry: KERNEL_POLICY_REGISTRY });
  const decision = compiler.pin(generation).evaluate({
    kind: "tool", phase: "pre", op: "provision", value: {}, role: "resident", sessionId: "test",
  });
  expect(decision).toMatchObject({
    generation: 1, verdict: "deny", reason: "unknown_ref",
    error: { code: "unknown_ref", ruleName: "missing-ref", ref: "app/not-registered" },
  });
});
