import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter, Storage } from "@openomni/session";
import {
  AppConnectorDiscovery,
  AppConnectorRegistry,
  BuiltInAppConnectors,
} from "../../src/index.js";

async function registerCodexInstallation(): Promise<string> {
  const connector = BuiltInAppConnectors.get("app.codex");
  if (connector === undefined) {
    throw new Error("expected built-in Codex connector");
  }
  const candidates = await AppConnectorDiscovery.discoverBuiltIns({
    connectors: [connector],
    runDetectCommand: async () => ({
      exitCode: 0,
      stdout: "codex-cli 0.139.0",
      stderr: "",
    }),
  });
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error("expected discovery candidate");
  }
  return AppConnectorRegistry.register(candidate, { registeredBy: "act_owner" }).id;
}

describe("AppConnectorRegistry lifecycle", () => {
  let tmpDir: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "app-connector-registry-lifecycle-test-"));
    adapter = new SqliteStorageAdapter(join(tmpDir, "test.db"));
    Storage.configure(adapter);
  });

  afterEach(async () => {
    adapter.close();
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("disables and uninstalls a consented connector installation", async () => {
    // Given
    const id = await registerCodexInstallation();
    AppConnectorRegistry.requestConsent(id);
    const consented = AppConnectorRegistry.grantConsent(id, {
      grantedBy: "act_owner",
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
    });

    // When
    const disabled = AppConnectorRegistry.disable(id);
    const removed = AppConnectorRegistry.uninstall(id);

    // Then
    expect(consented.status).toBe("consented");
    expect(disabled.status).toBe("disabled");
    expect(removed).toBe(true);
    expect(AppConnectorRegistry.get(id)).toBeUndefined();
  });
});
