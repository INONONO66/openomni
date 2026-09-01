import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppConnectorInstallationStore } from "../../src/app-connector/index";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";
import { installation } from "./fixture";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

describe("SqliteStorageAdapter appConnectorInstallation", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath("test-sqlite-app-connector");
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

});
