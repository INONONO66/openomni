import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter, Storage } from "@openomni/session";
import { ServerConnectorDefinitions } from "../../src/connector/definitions.js";
import { ServerConnectorDiscovery } from "../../src/connector/discovery.js";
import { ServerConnectorRegistry } from "../../src/connector/registry.js";

describe("ServerConnectorRegistry", () => {
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

  test("does not expose the removed duplicate remove lifecycle helper", async () => {
    // Given
    const registrySource = await Bun.file(
      new URL("../../src/connector/registry.ts", import.meta.url),
    ).text();

    // When / Then
    expect(Object.hasOwn(ServerConnectorRegistry, "remove")).toBe(false);
    expect(registrySource).not.toMatch(/\bexport\s+function\s+remove\b/);
  });

  test("registers an available discovery candidate as a durable installation", async () => {
    // Given
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

    // When
    const installation = ServerConnectorRegistry.register(candidate, {
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
    expect(ServerConnectorRegistry.get(installation.id)).toEqual(installation);
    expect(ServerConnectorRegistry.list()).toEqual([installation]);
  });

  test("requests and grants owner consent for a registered installation", async () => {
    // Given
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
    const installation = ServerConnectorRegistry.register(candidate, {
      registeredBy: "act_owner",
    });

    // When
    const pending = ServerConnectorRegistry.requestConsent(installation.id);
    const consented = ServerConnectorRegistry.grantConsent(installation.id, {
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
    expect(ServerConnectorRegistry.get(installation.id)).toEqual(consented);
  });

  test("rejects unavailable discovery candidates at registration", async () => {
    // Given
    const connector = ServerConnectorDefinitions.get("app.codex");
    if (connector === undefined) {
      throw new Error("expected server Codex connector");
    }
    const candidates = await ServerConnectorDiscovery.discover({
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
    expect(() =>
      ServerConnectorRegistry.register(candidate, { registeredBy: "act_owner" }),
    ).toThrow("Cannot register unavailable connector");
  });
});
