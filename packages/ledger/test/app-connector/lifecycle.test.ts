import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppConnector } from "@openomni/protocol";
import { ActorRegistry } from "../../src/actor/index";
import { AppConnectorInstallationStore } from "../../src/app-connector/index";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";
import { installation } from "./fixture";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

function consentInstallation(id: string): AppConnector.Installation {
  return AppConnectorInstallationStore.set({
    ...installation(id),
    status: "consented",
    consent: {
      grantedBy: "act_owner",
      grantedAt: Date.now(),
      capabilities: ["git"],
      permissions: [{ action: "tool.call", allowlist: ["git.*"] }],
    },
  });
}

describe("AppConnectorInstallationStore lifecycle", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath("test-sqlite-app-connector-lifecycle");
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

  test("disables a consented installation and preserves consent metadata", () => {
    // Given
    const consented = consentInstallation("install-1");

    // When
    const disabled = AppConnectorInstallationStore.disable(consented.id);

    // Then
    expect(disabled.status).toBe("disabled");
    expect(disabled.consent).toEqual(consented.consent);
    expect(disabled.createdAt).toBe(consented.createdAt);
    expect(disabled.updatedAt).toBeGreaterThanOrEqual(consented.updatedAt);
    expect(AppConnectorInstallationStore.get(consented.id)).toEqual(disabled);
  });

  test("rejects storage adapters without app connector installation support", () => {
    // Given
    const adapterWithoutAppConnector = {
      transaction: <T>(operation: () => T): T => operation(),
      session: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
      message: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
      part: {
        get: () => undefined,
        set: () => undefined,
        list: () => [],
        remove: () => false,
      },
    } satisfies Storage.Adapter;
    Storage.configure(adapterWithoutAppConnector);

    // When / Then
    expect(() => AppConnectorInstallationStore.list()).toThrow(
      "Storage adapter does not implement app connector installations",
    );
  });

  test("creates an ai agent actor endpoint when an installation is stored", () => {
    const stored = AppConnectorInstallationStore.set(installation("install-actor"));

    const actorRegistry = Storage.get().actorRegistry;
    expect(actorRegistry?.getIdentity("actor:install-actor")).toMatchObject({
      kind: "ai_agent",
      trustTier: "assigned_worker",
    });
    expect(actorRegistry?.getEndpoint(stored.endpointId)).toMatchObject({
      id: "endpoint:install-actor",
      actorId: "actor:install-actor",
      channel: "app_connector",
      externalId: "install-actor",
    });
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

  test("uninstalls an installation and its actor records without removing unrelated actors", () => {
    // Given
    const consented = consentInstallation("install-1");
    ActorRegistry.registerIdentity({
      id: "act-unrelated",
      kind: "human",
      trustTier: "owner",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-unrelated",
      actorId: "act-unrelated",
      channel: "discord",
      externalId: "unrelated-user",
    });

    // When
    const removed = AppConnectorInstallationStore.uninstall(consented.id);

    // Then
    expect(removed).toBe(true);
    expect(AppConnectorInstallationStore.get(consented.id)).toBeUndefined();
    expect(ActorRegistry.getIdentity("actor:install-1")).toBeUndefined();
    expect(ActorRegistry.getEndpoint(consented.endpointId)).toBeUndefined();
    expect(ActorRegistry.getIdentity("act-unrelated")).toBeDefined();
    expect(ActorRegistry.getEndpoint("endpoint-unrelated")).toBeDefined();
    expect(() => AppConnectorInstallationStore.uninstall(consented.id)).toThrow(
      "AppConnector installation not found",
    );
  });

  test("rolls back uninstall when actor cleanup is interrupted", () => {
    // Given
    const stored = AppConnectorInstallationStore.set(installation("install-interrupted"));
    const actorRegistry = adapter.actorRegistry;
    const removeIdentity = actorRegistry.removeIdentity;
    actorRegistry.removeIdentity = (id) => {
      removeIdentity(id);
      throw new Error("injected actor cleanup failure");
    };

    // When / Then
    expect(() => AppConnectorInstallationStore.uninstall(stored.id)).toThrow(
      "injected actor cleanup failure",
    );
    expect(AppConnectorInstallationStore.get(stored.id)).toEqual(stored);
    expect(ActorRegistry.getIdentity("actor:install-interrupted")).toBeDefined();
    expect(ActorRegistry.getEndpoint(stored.endpointId)).toBeDefined();
  });

});
