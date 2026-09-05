import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openomni/ledger";
import type { OpenOmniConfig } from "../../src/config";
import { startOpenOmni } from "../../src/index";
import { closeSocket, openSocket } from "./ws";

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
  /** Owns every connected socket until cleanup, including assertion failures. */
  openSocket(url: string, protocols: string[], timeoutMs?: number): Promise<WebSocket>;
  /** Registers an owned resource immediately, before the next fallible operation. */
  defer(dispose: () => Promise<void> | void): void;
  cleanup(): Promise<void>;
}

/**
 * One suite's app lifecycle: tracked temp state directories, at most one
 * running app per test, and a storage reset between tests. `beforeReset`
 * runs after registered disposers and before app/storage teardown, so
 * suite-specific completion witnesses can await the resources just closed.
 */
export function residentSuite(beforeReset?: () => Promise<void> | void): ResidentSuite {
  const directories: string[] = [];
  let stop: (() => Promise<void>) | undefined;
  const sockets: WebSocket[] = [];
  const disposers: (() => Promise<void> | void)[] = [];

  async function cleanup() {
    const failures: Error[] = [];
    // Every owner gets a disposal attempt; no later failure replaces an earlier one.
    async function attempt(dispose: () => Promise<void> | void) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error instanceof Error
          ? error
          : new Error("non-Error cleanup rejection", { cause: error }));
      }
    }
    await Promise.all(sockets.splice(0).map((ws) => attempt(() => closeSocket(ws))));
    for (const dispose of disposers.splice(0).reverse()) await attempt(dispose);
    await attempt(() => beforeReset?.());
    const stopApp = stop;
    stop = undefined;
    await attempt(() => stopApp?.());
    await attempt(() => Storage.reset());
    for (const directory of directories.splice(0)) {
      await attempt(() => rmSync(directory, { recursive: true, force: true }));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "resident suite cleanup failed");
  }
  afterEach(cleanup);

  return {
    cleanup,
    defer(dispose) {
      disposers.push(dispose);
    },
    async openSocket(url, protocols, timeoutMs) {
      const ws = await openSocket(url, protocols, timeoutMs);
      sockets.push(ws);
      return ws;
    },
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
