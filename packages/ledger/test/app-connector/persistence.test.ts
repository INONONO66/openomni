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

  test("store records owner consent as a status transition", async () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    const pending = AppConnectorInstallationStore.requestConsent(registered.id);
    await Bun.sleep(2);

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

  test("store rejects consent grants outside connector requirements", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        credentials: ["ANTHROPIC_API_KEY"],
      }),
    ).toThrow("not requested by connector");
  });

  test("store rejects consent capabilities outside connector requirements", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        capabilities: ["shell"],
      }),
    ).toThrow("not requested by connector");
  });

  test("store rejects consent permissions broader than connector requirements", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [{ action: "tool.call", allowlist: ["*"] }],
      }),
    ).toThrow("exceeds connector requirement");
  });

  test("store rejects unrequested allow dimensions that bypass requested label ceilings", () => {
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [{ action: "tool.call", allowLabels: ["capability:read"] }],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [
          {
            action: "tool.call",
            allowLabels: ["capability:read"],
            allowlist: ["*"],
          },
        ],
      }),
    ).toThrow("allowlist exceeds connector requirement");
  });

  test("store rejects consent permissions that omit requested allowing fields", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [{ action: "tool.call" }],
      }),
    ).toThrow("omits connector requirement");
  });

  test("store rejects consent permissions that omit requested restrictive fields", () => {
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [{ action: "tool.call", denylist: ["rm.*"] }],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [{ action: "tool.call" }],
      }),
    ).toThrow("denylist omits connector requirement");
  });

  test("store rejects consent permissions that weaken requested restrictive fields", () => {
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [{ action: "tool.call", denylist: ["rm.*"] }],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [{ action: "tool.call", denylist: [] }],
      }),
    ).toThrow("denylist omits connector requirement");
  });

  test("store rejects consent that omits requested permission actions", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        capabilities: ["git"],
      }),
    ).toThrow("omit connector requirements");
  });

  test("store rejects empty consent permissions when connector requires permissions", () => {
    const registered = AppConnectorInstallationStore.set(installation("install-1", 100));
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [],
      }),
    ).toThrow("omit connector requirements");
  });

  test("store rejects consent permissions that omit one requested action", () => {
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [
            { action: "tool.call", allowlist: ["git.*"] },
            { action: "file.read", allowlist: ["docs/*"] },
          ],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
      }),
    ).toThrow("omits connector requirement");
  });

  test("store rejects connector permission requirements with duplicate actions", () => {
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [
            { action: "tool.call", allowlist: ["git.*"] },
            { action: "tool.call", allowLabels: ["capability:read"] },
          ],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [
          {
            action: "tool.call",
            allowlist: ["git.*"],
            allowLabels: ["capability:read"],
          },
        ],
      }),
    ).toThrow("duplicate connector requirement");
  });

  test("store rejects consent input rules that duplicate one requested rule and omit another", () => {
    const firstRule = {
      toolPattern: "bash",
      field: "command",
      pattern: "^git",
      action: "allow" as const,
      priority: 0,
    };
    const secondRule = {
      toolPattern: "bash",
      field: "command",
      pattern: "^bun",
      action: "allow" as const,
      priority: 0,
    };
    const record = installation("install-1", 100);
    const registered = AppConnectorInstallationStore.set({
      ...record,
      definition: {
        ...record.definition,
        requires: {
          ...record.definition.requires,
          permissions: [
            {
              action: "tool.call",
              allowlist: ["bash"],
              inputRules: [firstRule, secondRule],
            },
          ],
        },
      },
    });
    AppConnectorInstallationStore.requestConsent(registered.id);

    expect(() =>
      AppConnectorInstallationStore.grantConsent(registered.id, {
        grantedBy: "act_owner",
        permissions: [
          {
            action: "tool.call",
            allowlist: ["bash"],
            inputRules: [firstRule, firstRule],
          },
        ],
      }),
    ).toThrow("inputRules omits connector requirement");
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
