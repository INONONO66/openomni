import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, Journal } from "@openomni/agent";
const SEEDED_POLICY_ROWS = Kernel.SEEDED_POLICY_ROWS;
const openCatalogStore = Journal.openCatalogStore;
import type { PolicyRow } from "@openomni/protocol";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { MESSAGE_POLICY_ROWS } from "../src/message-policy";
import { PROVISION_POLICY_ROWS } from "../src/tools/provision";
import { testClock } from "./helpers/test-entropy";

const identity = (row: Omit<PolicyRow.Row, "generation">) =>
  JSON.stringify([row.name, row.kind, row.phase]);
const budgetId = JSON.stringify(["monitor-wake-budget", "tool", "pre"]);
const expectedIds = [
  ...SEEDED_POLICY_ROWS.map(identity),
  ...MESSAGE_POLICY_ROWS.map(identity),
  ...PROVISION_POLICY_ROWS.map(identity),
  budgetId,
].sort();

type CatalogStore = ReturnType<typeof openCatalogStore>;

function withDatabase(run: (open: () => CatalogStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "policy-seed-"));
  const path = join(directory, "catalog.sqlite");
  const opened: CatalogStore[] = [];
  const open = () => {
    const catalog = openCatalogStore(path, { now: testClock() });
    opened.push(catalog);
    return catalog;
  };
  try {
    run(open, path);
  } finally {
    for (const catalog of opened) catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("interrupted policy promotion rolls back every row and reopens with the complete generation", () => {
  withDatabase((open, path) => {
    const first = open();
    const adapter = first.policies;
    for (const row of SEEDED_POLICY_ROWS) {
      expect(adapter.append({ ...row, generation: 1 })).toBe(true);
    }
    const original = adapter.rows(1);
    const fault = new Database(path);
    try {
      fault.run(`CREATE TRIGGER fail_partial_policy BEFORE INSERT ON policy
        WHEN NEW.generation = 2 AND (SELECT COUNT(*) FROM policy WHERE generation = 2) = 1
        BEGIN SELECT RAISE(ABORT, 'policy-upgrade-fault'); END`);
      expect(() => seedKernelPolicyRows(adapter)).toThrow("policy-upgrade-fault");
      expect(adapter.rows(2)).toEqual([]);
      expect(adapter.rows()).toEqual(original);
      fault.run("DROP TRIGGER fail_partial_policy");
    } finally {
      fault.close();
    }
    first.close();
    const reopened = open().policies;
    expect(seedKernelPolicyRows(reopened)).toBe(2);
    expect(reopened.rows(2).map(identity).sort()).toEqual(expectedIds);
    expect(reopened.rows(1)).toEqual(original);
    const complete = reopened.rows();
    expect(seedKernelPolicyRows(reopened)).toBe(2);
    expect(reopened.rows()).toEqual(complete);
  });
});

test("budget presence alone does not complete a generation; preserve existing policy content", () => {
  withDatabase((open) => {
    const policies = open().policies;
    expect(seedKernelPolicyRows(policies)).toBe(1);
    expect(policies.rows(1).map(identity).sort()).toEqual(expectedIds);
    const budget = policies.rows(1).find((row) => identity(row) === budgetId);
    if (budget === undefined) throw new Error("missing seeded budget");
    const custom = { ...budget, name: "site-policy", priority: 42, generation: 2 };
    expect(policies.append({ ...budget, generation: 2 })).toBe(true);
    expect(policies.append(custom)).toBe(true);
    expect(seedKernelPolicyRows(policies)).toBe(3);
    expect(policies.rows(3).map(identity).sort()).toEqual(
      [...expectedIds, identity(custom)].sort(),
    );
    expect(policies.rows(3)).toContainEqual({ ...custom, generation: 3 });
    expect(policies.rows(3)).toContainEqual({ ...budget, generation: 3 });
    const complete = policies.rows();
    expect(seedKernelPolicyRows(policies)).toBe(3);
    expect(policies.rows()).toEqual(complete);
  });
});
