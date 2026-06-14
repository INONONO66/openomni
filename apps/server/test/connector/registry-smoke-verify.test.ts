import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConnector } from "@openomni/protocol";
import {
  AppConnectorInstallationStore,
  Bus,
  SqliteStorageAdapter,
  Storage,
} from "@openomni/session";
import {
  ServerConnectorDiscovery,
  ServerConnectorRegistry,
  ServerConnectorDefinitions,
} from "../../src/connector/index.js";

async function availableCodexCandidate(): Promise<AppConnector.Definition> {
  const connector = ServerConnectorDefinitions.get("app.codex");
  if (connector === undefined) {
    throw new Error("expected server Codex connector");
  }
  return connector;
}

async function registerConsentedCodexInstallation(): Promise<AppConnector.Installation> {
  const connector = await availableCodexCandidate();
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
  const registered = ServerConnectorRegistry.register(candidate, { registeredBy: "act_owner" });
  ServerConnectorRegistry.requestConsent(registered.id);
  return ServerConnectorRegistry.grantConsent(registered.id, {
    grantedBy: "act_owner",
    capabilities: ["git"],
    permissions: [{ action: "tool.call", allowlist: ["bash", "edit", "grep", "read"] }],
  });
}

async function expectSmokeVerifyRejects(id: string, message: string): Promise<void> {
  try {
    await ServerConnectorRegistry.smokeVerify(id, {});
  } catch (error) {
    if (error instanceof Error) {
      expect(error.message).toContain(message);
      return;
    }
    throw error;
  }
  throw new Error(`Expected smoke verification to reject for ${id}`);
}

async function captureVerificationEvents(run: () => Promise<void>): Promise<unknown[]> {
  const events: unknown[] = [];
  const unsubscribe = Bus.observe((descriptor, payload) => {
    if (descriptor.name === "app_connector.verification.failed") events.push(payload);
  });

  try {
    await run();
    await Bun.sleep(0);
    return events;
  } finally {
    unsubscribe();
  }
}

describe("ServerConnectorRegistry smoke verification", () => {
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
    Bus.reset();
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("enables a consented installation when injected detect succeeds", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const enabled = await ServerConnectorRegistry.smokeVerify(consented.id, {
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
    expect(ServerConnectorRegistry.get(consented.id)).toEqual(enabled);
  });

  test("records verification_failed when injected detect reports an unsupported version", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const failed = await ServerConnectorRegistry.smokeVerify(consented.id, {
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
    expect(ServerConnectorRegistry.get(consented.id)).toEqual(failed);
  });

  test("publishes a version drift incident when smoke verification detects an unsupported version", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const events = await captureVerificationEvents(async () => {
      await ServerConnectorRegistry.smokeVerify(consented.id, {
        runDetectCommand: async () => ({
          exitCode: 0,
          stdout: "codex-cli 9.0.0",
          stderr: "",
        }),
      });
    });

    // Then
    expect(events).toEqual([
      expect.objectContaining({
        installationId: consented.id,
        connectorId: consented.connectorId,
        reason: "unsupported_version",
        detectedVersion: "9.0.0",
        testedVersions: consented.testedVersions,
      }),
    ]);
  });

  test("publishes a detection failure incident when smoke verification cannot read a version", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const events = await captureVerificationEvents(async () => {
      await ServerConnectorRegistry.smokeVerify(consented.id, {
        runDetectCommand: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "detect failed",
        }),
      });
    });

    // Then
    expect(events).toEqual([
      expect.objectContaining({
        installationId: consented.id,
        connectorId: consented.connectorId,
        reason: "detect_failed",
        diagnostic: "detect failed",
      }),
    ]);
  });

  test("publishes a missing candidate incident when smoke verification cannot spawn detect", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();

    // When
    const events = await captureVerificationEvents(async () => {
      await ServerConnectorRegistry.smokeVerify(consented.id, {
        runDetectCommand: async () => ({
          exitCode: 127,
          stdout: "",
          stderr: "command not found",
        }),
      });
    });

    // Then
    expect(events).toEqual([
      expect.objectContaining({
        installationId: consented.id,
        connectorId: consented.connectorId,
        reason: "missing_candidate",
        diagnostic: "command not found",
      }),
    ]);
  });

  test("redacts and bounds detection failure diagnostics before publishing incidents", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();
    const secret = "OPENAI_API_KEY=sk-secret-value";
    const repeated = "x".repeat(700);

    // When
    const events = await captureVerificationEvents(async () => {
      await ServerConnectorRegistry.smokeVerify(consented.id, {
        runDetectCommand: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: `${secret}\n${repeated}`,
        }),
      });
    });

    // Then
    const event = events[0] as { readonly diagnostic?: string } | undefined;
    expect(event?.diagnostic).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(event?.diagnostic).not.toContain("sk-secret-value");
    expect(event?.diagnostic?.length).toBeLessThanOrEqual(512);
  });

  test("rejects smoke verification for missing, disabled, and non-consented installations", async () => {
    // Given
    const consented = await registerConsentedCodexInstallation();
    const disabled = ServerConnectorRegistry.disable(consented.id);
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
    const pending = ServerConnectorRegistry.requestConsent(pendingSeed.id);

    // When / Then
    await expectSmokeVerifyRejects("install:missing", "AppConnector installation not found");
    await expectSmokeVerifyRejects(disabled.id, "Cannot smoke verify disabled installation");
    await expectSmokeVerifyRejects(registered.id, "Cannot smoke verify registered installation");
    await expectSmokeVerifyRejects(pending.id, "Cannot smoke verify pending_consent installation");
  });
});
