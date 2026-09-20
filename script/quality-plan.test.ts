import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory, readContract } from "./quality-inventory";
import { qualityPlan } from "./quality-plan";

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
