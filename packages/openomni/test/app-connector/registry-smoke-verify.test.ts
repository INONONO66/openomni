import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConnector } from "@openomni/protocol";
import { AppConnectorInstallationStore, SqliteStorageAdapter, Storage } from "@openomni/session";
import {
  AppConnectorDiscovery,
  AppConnectorRegistry,
  BuiltInAppConnectors,
} from "../../src/index.js";

async function availableCodexCandidate(): Promise<AppConnector.Definition> {
  const connector = BuiltInAppConnectors.get("app.codex");
  if (connector === undefined) {
    throw new Error("expected built-in Codex connector");
  }
  return connector;
}

async function registerConsentedCodexInstallation(): Promise<AppConnector.Installation> {
  const connector = await availableCodexCandidate();
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
  const registered = AppConnectorRegistry.register(candidate, { registeredBy: "act_owner" });
  AppConnectorRegistry.requestConsent(registered.id);
  return AppConnectorRegistry.grantConsent(registered.id, {
    grantedBy: "act_owner",
    capabilities: ["git"],
    permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
  });
}

async function expectSmokeVerifyRejects(id: string, message: string): Promise<void> {
  try {
    await AppConnectorRegistry.smokeVerify(id, {});
  } catch (error) {
    if (error instanceof Error) {
      expect(error.message).toContain(message);
      return;
    }
    throw error;
  }
  throw new Error(`Expected smoke verification to reject for ${id}`);
}

describe("AppConnectorRegistry smoke verification", () => {
  let tmpDir: string;
  let dbPath: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "app-connector-registry-smoke-test-"));
    dbPath = join(tmpDir, "test.db");
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);
  });

  afterEach(async () => {
    adapter.close();
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("enables a consented installation when injected detect succeeds", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const enabled = await AppConnectorRegistry.smokeVerify(consented.id, {
      runDetectCommand: async () => ({
        exitCode: 0,
        stdout: "codex-cli 0.139.1",
        stderr: "",
      }),
    });
    adapter.close();
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);

    // Then
    expect(enabled.status).toBe("enabled");
    expect(enabled.detectedVersion).toBe("0.139.1");
    expect(enabled.consent).toEqual(consented.consent);
    expect(AppConnectorRegistry.get(consented.id)).toEqual(enabled);
  });

  test("records verification_failed when injected detect reports an unsupported version", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const failed = await AppConnectorRegistry.smokeVerify(consented.id, {
      runDetectCommand: async () => ({
        exitCode: 0,
        stdout: "codex-cli 9.0.0",
        stderr: "",
      }),
    });

    // Then
    expect(failed.status).toBe("verification_failed");
    expect(failed.detectedVersion).toBe("9.0.0");
    expect(failed.consent).toEqual(consented.consent);
    expect(AppConnectorRegistry.get(consented.id)).toEqual(failed);
  });

  test("rejects smoke verification for missing, disabled, and non-consented installations", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();
    const disabled = AppConnectorRegistry.disable(consented.id);
    const connector = await availableCodexCandidate();
    const registered = AppConnectorInstallationStore.set({
      id: "install:registered-edge",
      connectorId: connector.id,
      connectorVersion: connector.version,
      definition: connector,
      testedVersions: connector.detect.testedVersions,
      status: "registered",
      registeredBy: "act_owner",
    });
    const pendingSeed = AppConnectorInstallationStore.set({
      id: "install:pending-edge",
      connectorId: connector.id,
      connectorVersion: connector.version,
      definition: connector,
      testedVersions: connector.detect.testedVersions,
      status: "registered",
      registeredBy: "act_owner",
    });
    const pending = AppConnectorRegistry.requestConsent(pendingSeed.id);

    // When / Then
    await expectSmokeVerifyRejects("install:missing", "AppConnector installation not found");
    await expectSmokeVerifyRejects(disabled.id, "Cannot smoke verify disabled installation");
    await expectSmokeVerifyRejects(registered.id, "Cannot smoke verify registered installation");
    await expectSmokeVerifyRejects(pending.id, "Cannot smoke verify pending_consent installation");
  });
});
