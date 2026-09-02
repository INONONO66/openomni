import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Placement } from "@openomni/placement";
import type { DelegationOrigin } from "../../delegation/admission";
import { catalogEntries, type CatalogPorts } from "./catalog";
import { HOST_TARGET } from "./dispatch";
import { TOOL_PROJECTOR_VERSION } from "./project";

// Captured from base commit 742e67f3 before defineTool migration.
const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/menu-parity-742e67f3.json", import.meta.url), "utf8"),
) as Record<string, string[]>;
const fingerprintFixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/menu-fingerprints-742e67f3.json", import.meta.url), "utf8"),
) as { projectorVersion: number; fingerprints: Record<string, string> };

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
} as unknown as CatalogPorts;

function names(door: "model" | "cell", role: "resident" | "worker", ports: CatalogPorts) {
  const origin = {
    role,
    depth: role === "resident" ? 0 : 1,
    sessionId: "fixture",
  } as DelegationOrigin;
  const targets: Placement.ToolTarget[] =
    door === "cell"
      ? [HOST_TARGET]
      : [
          HOST_TARGET,
          {
            kind: "machine",
            id: "fixture",
            capabilities: ["kernel.py", "sandbox.process", "fs.read"],
          },
        ];
  return Placement.resolveTools(
    catalogEntries(ports, origin).map((entry) => entry.spec),
    targets,
  )
    .filter((decision) => decision.offerable)
    .map((decision) => decision.tool.name);
}

describe("full catalog menu parity", () => {
  for (const door of ["model", "cell"] as const) {
    for (const role of ["resident", "worker"] as const) {
      for (const ports of ["full", "empty"] as const) {
        const key = `${door}:${role}:${ports}`;
        it(`matches 742e67f3 for ${key}`, () => {
          const first = names(door, role, ports === "full" ? fullPorts : {});
          const second = names(door, role, ports === "full" ? fullPorts : {});
          const expected = fixture[key];
          const fingerprint = fingerprintFixture.fingerprints[key];
          if (expected === undefined || fingerprint === undefined)
            throw new Error(`missing fixture ${key}`);
          expect(first).toEqual(expected);
          expect(second).toEqual(first);
          expect(TOOL_PROJECTOR_VERSION).toBe(fingerprintFixture.projectorVersion);
          expect(
            createHash("sha256")
              .update(`${TOOL_PROJECTOR_VERSION}:${first.join("\0")}`)
              .digest("hex"),
          ).toBe(fingerprint);
        });
      }
    }
  }
});
