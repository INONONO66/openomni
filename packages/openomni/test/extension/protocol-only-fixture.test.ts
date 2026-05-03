import { beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Extension } from "@openomni/protocol";
import { Session, SqliteStorageAdapter, Storage } from "@openomni/session";
import { getManifest } from "../../../../tests/fixtures/protocol-only/src/index";
import { ExtensionManager } from "../../src/extension";

const fixedDate = new Date("2026-05-04T00:00:00.000Z");
const actor = { kind: "user", id: "protocol-fixture-test" };
const fixtureRoot = fileURLToPath(
  new URL("../../../../tests/fixtures/protocol-only/", import.meta.url),
);

let sessionId: string;

beforeEach(() => {
  Storage.configure(new SqliteStorageAdapter(":memory:"));
  sessionId = Session.create({
    title: "protocol-only-fixture-test",
    model: { providerID: "test", modelID: "test" },
  }).id;
});

describe("protocol-only extension fixture", () => {
  it("uses only protocol imports from OpenOmni packages", async () => {
    const files = await fixtureContractFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = await Bun.file(file).text();
      const imports = Array.from(text.matchAll(/@openomni\/[a-z0-9-]+/g), (match) => match[0]);
      expect(imports.every((specifier) => specifier === "@openomni/protocol")).toBe(true);
    }
  });

  it("builds a protocol manifest accepted by ExtensionManager lifecycle", async () => {
    const manifest = getManifest();
    const parsed = Extension.Manifest.parse(manifest);

    expect(parsed.contributes?.agents).toHaveLength(1);
    expect(parsed.contributes?.tools).toHaveLength(1);
    expect(parsed.contributes?.skills).toHaveLength(1);
    expect(parsed.contributes?.mcpServers).toHaveLength(1);

    const validation = await ExtensionManager.validate(parsed, operationOptions());
    expect(validation.success).toBe(true);

    const proposed = await ExtensionManager.requestInstall(parsed, {
      ...operationOptions(),
      reason: "protocol-only fixture contract",
    });
    expect(proposed).toMatchObject({ id: parsed.id, version: parsed.version, state: "proposed" });
    expect(proposed.manifest?.contributes).toEqual({
      agents: 1,
      tools: 1,
      skills: 1,
      mcpServers: 1,
      middlewares: 0,
      surfaces: 0,
    });

    await ExtensionManager.approve(parsed.id, operationOptions());
    await ExtensionManager.install(parsed.id, operationOptions());
    const enabled = await ExtensionManager.enable(parsed.id, operationOptions());

    expect(enabled).toMatchObject({ id: parsed.id, version: parsed.version, state: "enabled" });
  });
});

function operationOptions() {
  return {
    actor,
    audit: { sessionId },
    now: () => fixedDate,
  };
}

async function fixtureContractFiles(): Promise<string[]> {
  const sourceFiles = await Array.fromAsync(
    new Bun.Glob("src/**/*.ts").scan({ cwd: fixtureRoot, onlyFiles: true }),
    (file) => join(fixtureRoot, file),
  );

  return [join(fixtureRoot, "package.json"), join(fixtureRoot, "tsconfig.json"), ...sourceFiles];
}
