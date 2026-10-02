import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeJson, digest, InventoryError, jsonArray, jsonChoice, jsonLiteral, jsonObject, jsonString, readContract, type Inventory } from "./quality-inventory";
import { TOPOLOGY } from "./topology";

/** Keep the full resolver inventory; scope only measurement, never ownership. */
export function qualityPlan(root: string, contractPath: string, inventory: Inventory, path?: string) {
  const contract = readContract(resolve(root, contractPath));
  const all = inventory.files.map((row) => row.path);
  let whole = true;
  let paths = all;
  let projects = contract.projects;
  if (path) {
    const row = jsonObject(decodeJson(readFileSync(resolve(root, path), "utf8")));
    jsonLiteral(row.version, 2);
    const changeClass = jsonChoice(row.class, ["docs", "desktop", "kernel", "tooling", "global"]);
    whole = changeClass === "global" || changeClass === "tooling";
    paths = jsonArray(row.qualityScope, jsonString);
    projects = jsonArray(row.projects, jsonString);
    for (const [selected, allowed] of [[paths, all], [projects, contract.projects]]) {
      if (!selected || !allowed || new Set(selected).size !== selected.length || selected.some((entry) => !allowed.includes(entry)) || (whole && selected.length !== allowed.length)) {
        throw new InventoryError("plan", path, "invalid quality scope or projects");
      }
    }
  }
  const workspaces = TOPOLOGY.filter((workspace) => paths.some((path) => path.startsWith(`${workspace.dir}/`))).map((workspace) => workspace.dir);
  return { whole, paths, projects, workspaces, hash: digest(JSON.stringify({ whole, paths, projects })) };
}
