import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Placement } from "@openomni/placement";
import type { DelegationOrigin } from "../../delegation/admission";
import { catalogEntries, type CatalogPorts } from "./catalog";
import { HOST_TARGET } from "./dispatch";

// Captured from base commit 742e67f3 before defineTool migration.
const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/menu-parity-742e67f3.json", import.meta.url), "utf8"),
) as Record<string, string[]>;

const fullPorts = {
  delegation: {},
  conversations: {},
  leases: {},
  approvals: {},
  cells: {},
  machines: () => [],
  machineFs: {},
  memory: {},
  workItems: {},
  llm: async () => "",
  artifacts: {},
  provisioning: {},
} as CatalogPorts;

function names(door: "model" | "cell", role: "resident" | "worker", ports: CatalogPorts) {
  const origin = {
    role,
    depth: role === "resident" ? 0 : 1,
    sessionId: "fixture",
  } as DelegationOrigin;
  const targets: Placement.ToolTarget[] = door === "cell"
    ? [HOST_TARGET]
    : [HOST_TARGET, { kind: "machine", id: "fixture", capabilities: ["kernel.py", "fs.read"] }];
  return Placement.resolveTools(catalogEntries(ports, origin).map((entry) => entry.spec), targets)
    .filter((decision) => decision.offerable)
    .map((decision) => decision.tool.name);
}

describe("phase-A catalog menu parity", () => {
  for (const door of ["model", "cell"] as const) {
    for (const role of ["resident", "worker"] as const) {
      for (const ports of ["full", "empty"] as const) {
        const key = `${door}:${role}:${ports}`;
        it(`matches 742e67f3 for ${key}`, () => {
          expect(names(door, role, ports === "full" ? fullPorts : {})).toEqual(fixture[key]);
        });
      }
    }
  }
});
