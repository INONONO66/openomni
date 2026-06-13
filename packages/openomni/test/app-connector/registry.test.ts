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

describe("AppConnectorRegistry", () => {
  let tmpDir: string;
  let dbPath: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "app-connector-registry-test-"));
    dbPath = join(tmpDir, "test.db");
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);
  });

  afterEach(async () => {
    adapter.close();
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("registers an available discovery candidate as a durable installation", async () => {
    // Given
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

    // When
    const installation = AppConnectorRegistry.register(candidate, {
      registeredBy: "act_owner",
    });
    adapter.close();
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);

    // Then
    expect(installation).toMatchObject({
      connectorId: "app.codex",
      detectedVersion: "0.139.0",
      status: "registered",
      registeredBy: "act_owner",
    });
    expect(AppConnectorRegistry.get(installation.id)).toEqual(installation);
    expect(AppConnectorRegistry.list()).toEqual([installation]);
  });

  test("requests and grants owner consent for a registered installation", async () => {
    // Given
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
    const installation = AppConnectorRegistry.register(candidate, {
      registeredBy: "act_owner",
    });

    // When
    const pending = AppConnectorRegistry.requestConsent(installation.id);
    const consented = AppConnectorRegistry.grantConsent(installation.id, {
      grantedBy: "act_owner",
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
    });
    adapter.close();
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);

    // Then
    expect(pending.status).toBe("pending_consent");
    expect(consented.status).toBe("consented");
    expect(consented.consent).toMatchObject({
      grantedBy: "act_owner",
      capabilities: ["git"],
    });
    expect(AppConnectorRegistry.get(installation.id)).toEqual(consented);
  });

  test("rejects unavailable discovery candidates at registration", async () => {
    // Given
    const connector = BuiltInAppConnectors.get("app.codex");
    if (connector === undefined) {
      throw new Error("expected built-in Codex connector");
    }
    const candidates = await AppConnectorDiscovery.discoverBuiltIns({
      connectors: [connector],
      runDetectCommand: async () => ({
        exitCode: 127,
        stdout: "",
        stderr: "command not found",
      }),
    });
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new Error("expected discovery candidate");
    }

    // When / Then
    expect(() => AppConnectorRegistry.register(candidate, { registeredBy: "act_owner" })).toThrow(
      "Cannot register unavailable connector",
    );
  });
});
