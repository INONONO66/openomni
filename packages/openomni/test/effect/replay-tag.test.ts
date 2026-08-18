import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EffectStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import {
  EffectManifest,
  EffectService,
  type EffectDriver,
  type EffectExecution,
  type EffectIntent,
} from "../../src/effect/index.js";

let adapter: SqliteStorageAdapter | undefined;

beforeEach(() => {
  adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
});

afterEach(() => {
  Storage.reset();
  adapter?.close();
  adapter = undefined;
});

function driverWith(replay: "never" | "safe"): EffectDriver {
  return {
    kind: `tagged.${replay}`,
    replay,
    execute: (): EffectExecution => ({ kind: "confirmed", receipt: "ok" }),
    reconcile: (_intent: EffectIntent): EffectExecution => ({ kind: "confirmed", receipt: "ok" }),
  };
}

/**
 * The replay tag is written at record time, by the one party that knows the
 * effect's nature — the driver. A replay or recovery consumer reads the
 * ledger, never re-derives the judgment; a row recorded before the
 * vocabulary existed has no tag and MUST be treated as "never".
 */
describe("effect replay tag", () => {
  test("the intent row carries the driver's declared replay tag", async () => {
    for (const replay of ["never", "safe"] as const) {
      const driver = driverWith(replay);
      const manifest = new EffectManifest();
      manifest.register(driver);
      const service = new EffectService(manifest);

      await service.run({ effectId: `effect-${replay}`, kind: driver.kind });

      const recorded = EffectStore.terminalIntents().find(
        (terminal) => terminal.intent.effectId === `effect-${replay}`,
      );
      expect(recorded?.intent.replay).toBe(replay);
    }
  });

  test("a replayed idempotency hit does not rewrite the recorded tag", async () => {
    const driver = driverWith("safe");
    const manifest = new EffectManifest();
    manifest.register(driver);
    const service = new EffectService(manifest);

    await service.run({ effectId: "effect-stable", kind: driver.kind });
    await service.run({ effectId: "effect-stable", kind: driver.kind });

    const recorded = EffectStore.terminalIntents().find(
      (terminal) => terminal.intent.effectId === "effect-stable",
    );
    expect(recorded?.intent.replay).toBe("safe");
  });
});
