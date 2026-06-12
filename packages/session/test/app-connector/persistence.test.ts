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
    `test-sqlite-app-connector-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
    requires: { capabilities: ["git"] },
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
      initialAutonomy: "approval_required",
    },
  };
}

function installation(id: string, createdAt: number): AppConnector.Installation {
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
    createdAt,
    updatedAt: createdAt,
  };
}

describe("SqliteStorageAdapter appConnectorInstallation", () => {
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

  test("set/get/list/remove round trips connector installations", () => {
    const first = installation("install-1", 100);
    const second = installation("install-2", 200);

    adapter.appConnectorInstallation.set(second);
    adapter.appConnectorInstallation.set(first);

    expect(adapter.appConnectorInstallation.get("install-1")).toEqual(first);
    expect(adapter.appConnectorInstallation.list()).toEqual([first, second]);
    expect(adapter.appConnectorInstallation.remove("install-1")).toBe(true);
    expect(adapter.appConnectorInstallation.get("install-1")).toBeUndefined();
    expect(adapter.appConnectorInstallation.list()).toEqual([second]);
  });

  test("persists connector installations across reopen", () => {
    const record = installation("install-1", 100);
    adapter.appConnectorInstallation.set(record);
    adapter.close();

    const adapter2 = new SqliteStorageAdapter(dbPath);
    expect(adapter2.appConnectorInstallation.list()).toEqual([record]);
    adapter2.close();
  });

  test("clear removes connector installations", () => {
    adapter.appConnectorInstallation.set(installation("install-1", 100));

    adapter.clear();

    expect(adapter.appConnectorInstallation.list()).toEqual([]);
  });

  test("store upsert preserves createdAt and refreshes updatedAt", async () => {
    const first = AppConnectorInstallationStore.set(installation("install-1", 100));
    await Bun.sleep(2);

    const replacement = {
      ...installation("install-1", 999),
      detectedVersion: "0.139.1",
    };
    const second = AppConnectorInstallationStore.set(replacement);

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.detectedVersion).toBe("0.139.1");
    expect(AppConnectorInstallationStore.list()).toEqual([second]);
  });
});
