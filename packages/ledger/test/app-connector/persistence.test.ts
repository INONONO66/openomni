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
    id: "app.example-worker",
    name: "Example Worker",
    version: "1.0.0",
    description: "Runs Example Worker as an installed connector endpoint",
    detect: {
      command: "codex",
      args: ["--version"],
      versionPattern: "^example-worker (?<version>\\d+\\.\\d+\\.\\d+)$",
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
      credentials: [],
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
    },
    driver: {
      provider: "codex",
      install: { scopes: ["user", "workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["submitted", "accepted", "running", "completed"],
      emits: ["exit_code"],
    },
    profile: {
      kind: "connector_endpoint",
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
    endpointId: `endpoint:${id}`,
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

  test("store upsert preserves createdAt and refreshes updatedAt", () => {
    const first = AppConnectorInstallationStore.set(installation("install-1", 100));

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

  test("store records owner consent as a status transition", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    const pending = AppConnectorInstallationStore.requestConsent(registered.id);

    const consented = AppConnectorInstallationStore.grantConsent(registered.id, {
      grantedBy: "act_owner",
      credentials: [],
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
    });

    expect(pending.status).toBe("pending_consent");
    expect(consented.status).toBe("consented");
    expect(consented.consent).toMatchObject({
      grantedBy: "act_owner",
      credentials: [],
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
    });
    expect(consented.consent?.grantedAt).toBeGreaterThanOrEqual(pending.updatedAt);
    expect(consented.createdAt).toBe(registered.createdAt);
    expect(consented.updatedAt).toBeGreaterThanOrEqual(pending.updatedAt);
    expect(AppConnectorInstallationStore.get(registered.id)).toEqual(consented);
  });

  test("store rejects every consent dimension outside connector requirements", () => {
    type ConsentInput = Parameters<typeof AppConnectorInstallationStore.grantConsent>[1];
    const firstRule = { toolPattern: "bash", field: "command", pattern: "^git", action: "allow" as const, priority: 0 };
    const secondRule = { ...firstRule, pattern: "^bun" };
    const cases: ReadonlyArray<{
      name: string;
      permissions?: AppConnector.Definition["requires"]["permissions"];
      consent: ConsentInput;
      error: string;
    }> = [
      { name: "unrequested credential", consent: { grantedBy: "act_owner", credentials: ["ANTHROPIC_API_KEY"] }, error: "not requested by connector" },
      { name: "unrequested capability", consent: { grantedBy: "act_owner", capabilities: ["shell"] }, error: "not requested by connector" },
      { name: "broader permission", consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call", allowlist: ["*"] }] }, error: "exceeds connector requirement" },
      { name: "unrequested allow dimension", permissions: [{ action: "tool.call", allowLabels: ["capability:read"] }], consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call", allowLabels: ["capability:read"], allowlist: ["*"] }] }, error: "allowlist exceeds connector requirement" },
      { name: "omitted allowing field", consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call" }] }, error: "omits connector requirement" },
      { name: "omitted restrictive field", permissions: [{ action: "tool.call", denylist: ["rm.*"] }], consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call" }] }, error: "denylist omits connector requirement" },
      { name: "weakened restrictive field", permissions: [{ action: "tool.call", denylist: ["rm.*"] }], consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call", denylist: [] }] }, error: "denylist omits connector requirement" },
      { name: "omitted permission actions", consent: { grantedBy: "act_owner", capabilities: ["git"] }, error: "omit connector requirements" },
      { name: "empty permissions", consent: { grantedBy: "act_owner", permissions: [] }, error: "omit connector requirements" },
      { name: "one omitted action", permissions: [{ action: "tool.call", allowlist: ["git.*"] }, { action: "file.read", allowlist: ["docs/*"] }], consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call", allowlist: ["git.*"] }] }, error: "omits connector requirement" },
      { name: "duplicate required action", permissions: [{ action: "tool.call", allowlist: ["git.*"] }, { action: "tool.call", allowLabels: ["capability:read"] }], consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call", allowlist: ["git.*"], allowLabels: ["capability:read"] }] }, error: "duplicate connector requirement" },
      { name: "duplicate input rule omits another", permissions: [{ action: "tool.call", allowlist: ["bash"], inputRules: [firstRule, secondRule] }], consent: { grantedBy: "act_owner", permissions: [{ action: "tool.call", allowlist: ["bash"], inputRules: [firstRule, firstRule] }] }, error: "inputRules omits connector requirement" },
    ];

    for (const [index, item] of cases.entries()) {
      const record = installation(`invalid-${index}`, 100 + index);
      const registered = AppConnectorInstallationStore.set(item.permissions === undefined ? record : {
        ...record,
        definition: { ...record.definition, requires: { ...record.definition.requires, permissions: item.permissions } },
      });
      AppConnectorInstallationStore.requestConsent(registered.id);
      expect(() => AppConnectorInstallationStore.grantConsent(registered.id, item.consent), item.name).toThrow(item.error);
    }
  });

  test("store permits omitted consent permissions when connector requests none", () => {
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    const consented = AppConnectorInstallationStore.grantConsent(registered.id, {
      grantedBy: "act_owner",
      capabilities: ["git"],
    });

    expect(consented.status).toBe("consented");
    expect(consented.consent?.permissions).toBeUndefined();
  });
});
