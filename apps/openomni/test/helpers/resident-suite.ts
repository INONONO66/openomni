import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import type { OpenOmniConfig } from "../../src/config";
import { startOpenOmni } from "../../src/index";

/** The provider-model resolution every fake-llm boot uses. */
export const fakeProviderModel = async (model: { provider: string; id: string }) => ({
  id: model.id,
  name: model.id,
  providerID: model.provider,
});

export interface ResidentSuite {
  /** A tracked temp directory, removed after each test. */
  tempDir(prefix: string): string;
  /** A minimal fake-model config whose durable state lives in a tracked temp dir. */
  config(prefix: string, overrides?: Partial<OpenOmniConfig>): OpenOmniConfig;
  /** Boots the app and owns stopping it after the test. */
  boot(options: Parameters<typeof startOpenOmni>[0]): ReturnType<typeof startOpenOmni>;
}

/**
 * One suite's app lifecycle: tracked temp state directories, at most one
 * running app per test, and a storage reset between tests. `beforeReset`
 * runs first in the teardown for suite-specific handles (bus journal,
 * machine daemons) that must close before storage goes away.
 */
export function residentSuite(beforeReset?: () => Promise<void> | void): ResidentSuite {
  const directories: string[] = [];
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await beforeReset?.();
    await stop?.();
    stop = undefined;
    Storage.reset();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  return {
    tempDir(prefix) {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      directories.push(directory);
      return directory;
    },
    config(prefix, overrides = {}) {
      const directory = this.tempDir(prefix);
      return {
        dbPath: join(directory, "chat.db"),
        host: "127.0.0.1",
        wsPort: 0,
        model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
        ...overrides,
      };
    },
    async boot(options) {
      const app = await startOpenOmni(options);
      stop = app.stop;
      return app;
    },
  };
}
