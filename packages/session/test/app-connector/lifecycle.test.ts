import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppConnector } from "@openomni/protocol";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConnectorInstallationStore } from "../../src/app-connector/index";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";

function tempDbPath(): string {
  return join(
    tmpdir(),
    `test-sqlite-app-connector-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
  }
}

function connectorDefinition(): AppConnector.Definition {
  return {
    id: "app.codex",
    name: "Codex CLI",
    version: "1.0.0",
    description: "Runs Codex CLI as an installed local CLI agent",
    detect: {
      command: "codex",
      args: ["--version"],
      versionPattern: "^codex-cli (?<version>\\d+\\.\\d+\\.\\d+)$",
      testedVersions: ">=0.139.0 <0.140.0",
    },
    spawn: {
      command: "codex",
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    },
    questionBridge: { kind: "none" },
    evidence: { emits: ["exit_code"] },
    requires: {
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
    },
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
      initialAutonomy: "approval_required",
    },
  };
}

function installation(id: string): AppConnector.Installation {
  const definition = connectorDefinition();
  return {
    id,
    connectorId: definition.id,
    connectorVersion: definition.version,
    definition,
    detectedVersion: "0.139.0",
    testedVersions: definition.detect.testedVersions,
    status: "registered",
    registeredBy: "act_owner",
    createdAt: 100,
    updatedAt: 100,
  };
}

function consentInstallation(id: string): AppConnector.Installation {
  const registered = AppConnectorInstallationStore.set(installation(id));
  AppConnectorInstallationStore.requestConsent(registered.id);
  return AppConnectorInstallationStore.grantConsent(registered.id, {
    grantedBy: "act_owner",
    capabilities: ["git"],
    permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
  });
}

describe("AppConnectorInstallationStore lifecycle", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath();
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    Storage.reset();
    removeSqliteFiles(dbPath);
  });

  test("disables a consented installation and preserves consent metadata", async () => {
    // Given
    const consented = consentInstallation("install-1");
    await Bun.sleep(2);

    // When
    const disabled = AppConnectorInstallationStore.disable(consented.id);

    // Then
    expect(disabled.status).toBe("disabled");
    expect(disabled.consent).toEqual(consented.consent);
    expect(disabled.createdAt).toBe(consented.createdAt);
    expect(disabled.updatedAt).toBeGreaterThanOrEqual(consented.updatedAt);
    expect(AppConnectorInstallationStore.get(consented.id)).toEqual(disabled);
  });

  test("marks a consented installation enabled when smoke verification succeeds", async () => {
    // Given
    const consented = consentInstallation("install-1");
    await Bun.sleep(2);

    // When
    const enabled = AppConnectorInstallationStore.markSmokeVerified(consented.id, {
      detectedVersion: "0.139.1",
    });

    // Then
    expect(enabled.status).toBe("enabled");
    expect(enabled.detectedVersion).toBe("0.139.1");
    expect(enabled.consent).toEqual(consented.consent);
    expect(enabled.createdAt).toBe(consented.createdAt);
    expect(enabled.updatedAt).toBeGreaterThanOrEqual(consented.updatedAt);
    expect(AppConnectorInstallationStore.get(consented.id)).toEqual(enabled);
  });

  test("marks a consented installation verification_failed when smoke verification fails", async () => {
    // Given
    const consented = consentInstallation("install-1");
    await Bun.sleep(2);

    // When
    const failed = AppConnectorInstallationStore.markSmokeVerificationFailed(consented.id, {
      detectedVersion: "9.0.0",
    });

    // Then
    expect(failed.status).toBe("verification_failed");
    expect(failed.detectedVersion).toBe("9.0.0");
    expect(failed.consent).toEqual(consented.consent);
    expect(failed.createdAt).toBe(consented.createdAt);
    expect(failed.updatedAt).toBeGreaterThanOrEqual(consented.updatedAt);
    expect(AppConnectorInstallationStore.get(consented.id)).toEqual(failed);
  });

  test("disables every pre-wire installation status", () => {
    const cases = [
      { id: "install-registered", status: "registered" },
      { id: "install-pending", status: "pending_consent" },
      { id: "install-consented", status: "consented" },
      { id: "install-enabled", status: "enabled" },
      { id: "install-verification-failed", status: "verification_failed" },
    ] satisfies readonly {
      readonly id: string;
      readonly status: AppConnector.InstallationStatus;
    }[];

    for (const record of cases) {
      AppConnectorInstallationStore.set({
        ...installation(record.id),
        status: record.status,
        ...(record.status === "enabled"
          ? { consent: { grantedBy: "act_owner", grantedAt: 1 } }
          : {}),
      });
      expect(AppConnectorInstallationStore.disable(record.id).status).toBe("disabled");
    }
  });

  test("uninstalls an existing installation and rejects a missing installation", () => {
    // Given
    const consented = consentInstallation("install-1");

    // When
    const removed = AppConnectorInstallationStore.uninstall(consented.id);

    // Then
    expect(removed).toBe(true);
    expect(AppConnectorInstallationStore.get(consented.id)).toBeUndefined();
    expect(() => AppConnectorInstallationStore.uninstall(consented.id)).toThrow(
      "AppConnector installation not found",
    );
  });

  test("rejects consent request after disable", () => {
    // Given
    const consented = consentInstallation("install-1");
    const disabled = AppConnectorInstallationStore.disable(consented.id);

    // When / Then
    expect(() => AppConnectorInstallationStore.requestConsent(disabled.id)).toThrow(
      "Cannot request consent for disabled installation",
    );
    expect(AppConnectorInstallationStore.get(disabled.id)).toEqual(disabled);
  });
});
