import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEEDED_POLICY_ROWS } from "@openomni/agent";
import { Storage } from "@openomni/ledger";
import type { PolicyRow } from "@openomni/protocol";
import { seedKernelPolicyRows } from "../src/policy-seed";

const identity = (row: Omit<PolicyRow.Row, "generation">) =>
  JSON.stringify([row.name, row.kind, row.phase]);
const budgetId = JSON.stringify(["monitor-wake-budget", "tool", "pre"]);
const expectedIds = [...SEEDED_POLICY_ROWS.map(identity), budgetId].sort();

function withDatabase(run: (path: string) => void): void {
  Storage.withIsolation(() => {
    const directory = mkdtempSync(join(tmpdir(), "policy-seed-"));
    const path = join(directory, "ledger.db");
    try {
      Storage.initialize({ dbPath: path });
      run(path);
    } finally {
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function policies() {
  const adapter = Storage.get().policies;
  if (adapter === undefined) throw new Error("missing policy adapter");
  return adapter;
}

test("interrupted policy promotion rolls back every row and reopens with the complete generation", () => {
  withDatabase((path) => {
    const adapter = policies();
    for (const row of SEEDED_POLICY_ROWS) {
      expect(adapter.append({ ...row, generation: 1 })).toBe(true);
    }
    const original = adapter.rows(1);
    const fault = new Database(path);
    try {
      fault.run(`CREATE TRIGGER fail_partial_policy BEFORE INSERT ON policy
        WHEN NEW.generation = 2 AND (SELECT COUNT(*) FROM policy WHERE generation = 2) = 1
        BEGIN SELECT RAISE(ABORT, 'policy-upgrade-fault'); END`);
      expect(() => seedKernelPolicyRows()).toThrow("policy-upgrade-fault");
      expect(adapter.rows(2)).toEqual([]);
      expect(adapter.rows()).toEqual(original);
      fault.run("DROP TRIGGER fail_partial_policy");
    } finally {
      fault.close();
    }
    Storage.reset();
    Storage.initialize({ dbPath: path });
    expect(seedKernelPolicyRows()).toBe(2);
    expect(policies().rows(2).map(identity).sort()).toEqual(expectedIds);
    expect(policies().rows(1)).toEqual(original);
    const complete = policies().rows();
    expect(seedKernelPolicyRows()).toBe(2);
    expect(policies().rows()).toEqual(complete);
  });
});

test("budget presence alone does not complete a generation; preserve existing policy content", () => {
  withDatabase(() => {
    expect(seedKernelPolicyRows()).toBe(1);
    expect(policies().rows(1).map(identity).sort()).toEqual(expectedIds);
    const budget = policies()
      .rows(1)
      .find((row) => identity(row) === budgetId);
    if (budget === undefined) throw new Error("missing seeded budget");
    const custom = { ...budget, name: "site-policy", priority: 42, generation: 2 };
    expect(policies().append({ ...budget, generation: 2 })).toBe(true);
    expect(policies().append(custom)).toBe(true);
    expect(seedKernelPolicyRows()).toBe(3);
    expect(policies().rows(3).map(identity).sort()).toEqual(
      [...expectedIds, identity(custom)].sort(),
    );
    expect(policies().rows(3)).toContainEqual({ ...custom, generation: 3 });
    expect(policies().rows(3)).toContainEqual({ ...budget, generation: 3 });
    const complete = policies().rows();
    expect(seedKernelPolicyRows()).toBe(3);
    expect(policies().rows()).toEqual(complete);
  });
});
