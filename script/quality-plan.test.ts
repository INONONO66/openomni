import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory, digest, readContract } from "./quality-inventory";
import { qualityPlan } from "./quality-plan";
import { carryUnmeasured } from "./quality-ratchet";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quality-plan-"));
  mkdirSync(join(root, "script"));
  writeFileSync(join(root, "script/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "script/b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "script/tsconfig.json"), '{"include":["*.ts"]}');
  writeFileSync(join(root, "contract.json"), JSON.stringify({ version: 1, typescript: "5.9.2", roots: ["script"], projects: ["script/tsconfig.json"], topology: false }));
  const inventory = buildInventory(root, readContract(join(root, "contract.json")));
  const plan = { version: 2, class: "desktop", qualityScope: ["script/a.ts"], projects: ["script/tsconfig.json"] };
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
  return { root, inventory, plan, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

test("quality plans reject unknown paths, duplicate scope, missing fields and narrowed global plans", () => {
  using repo = fixture();
  const load = () => qualityPlan(repo.root, "contract.json", repo.inventory, "plan.json");
  expect(load().paths).toEqual(["script/a.ts"]);
  for (const patch of [{ qualityScope: ["outside.ts"] }, { qualityScope: ["script/a.ts", "script/a.ts"] }, { projects: ["other.json"] }, { class: "global" }, { version: 1 }]) {
    writeFileSync(join(repo.root, "plan.json"), JSON.stringify({ ...repo.plan, ...patch }));
    expect(load).toThrow();
  }
});

test("carry-forward requires a baseline content proof for every unmeasured path, even without findings", () => {
  using repo = fixture();
  const finding = { gate: "publisher" as const, path: "script/b.ts", line: 1, symbol: "Ready", value: 1, count: 2 };
  const baseline = { version: 1 as const, complete: true, analyzed: ["publisher" as const], inventory: ["script/a.ts", "script/b.ts"], findings: [finding], sha256: { "script/b.ts": digest("export const b = 2;\n") } };
  const current = { version: 1 as const, complete: true, analyzed: ["publisher" as const], inventory: ["script/a.ts"], findings: [] };
  const carried = carryUnmeasured(repo.root, baseline, current, ["script/a.ts"]);
  expect(carried.inventory).toEqual(baseline.inventory);
  expect(carried.findings).toHaveLength(2);
  expect(carried.findings.every((row) => row.path === "script/b.ts")).toBe(true);
  expect(() => carryUnmeasured(repo.root, { ...baseline, sha256: {} }, current, ["script/a.ts"])).toThrow("script/b.ts");
  expect(() => carryUnmeasured(repo.root, { ...baseline, sha256: { "script/b.ts": "0".repeat(64) } }, current, ["script/a.ts"])).toThrow("script/b.ts");
  expect(carryUnmeasured(repo.root, baseline, current, ["script/a.ts"], ["publisher"]).findings).toEqual([]);
  const single = { ...finding, count: undefined };
  expect(carryUnmeasured(repo.root, { ...baseline, findings: [single] }, current, ["script/a.ts"]).findings).toHaveLength(1);
  rmSync(join(repo.root, "script/b.ts"));
  expect(() => carryUnmeasured(repo.root, baseline, current, ["script/a.ts"])).toThrow("missing unchanged source");
  writeFileSync(join(repo.root, "script/b.ts"), "export const b = 3;\n");
  expect(() => carryUnmeasured(repo.root, { ...baseline, findings: [] }, current, ["script/a.ts"])).toThrow("script/b.ts");
});
