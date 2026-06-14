import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter, Storage } from "@openomni/session";
import {
  ServerConnectorDiscovery,
  ServerConnectorRegistry,
  ServerConnectorDefinitions,
} from "../../src/connector/index.js";

async function registerCodexInstallation(): Promise<string> {
  const connector = ServerConnectorDefinitions.get("app.codex");
  if (connector === undefined) {
    throw new Error("expected server Codex connector");
  }
  const candidates = await ServerConnectorDiscovery.discover({
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
  return ServerConnectorRegistry.register(candidate, { registeredBy: "act_owner" }).id;
}

describe("ServerConnectorRegistry lifecycle", () => {
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
    ServerConnectorRegistry.requestConsent(id);
    const consented = ServerConnectorRegistry.grantConsent(id, {
      grantedBy: "act_owner",
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
    });

    // When
    const disabled = ServerConnectorRegistry.disable(id);
    const removed = ServerConnectorRegistry.uninstall(id);

    // Then
    expect(consented.status).toBe("consented");
    expect(disabled.status).toBe("disabled");
    expect(removed).toBe(true);
    expect(ServerConnectorRegistry.get(id)).toBeUndefined();
  });
});
