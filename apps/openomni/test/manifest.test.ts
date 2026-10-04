import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import { appManifest } from "../src/manifest";
import { runEffect } from "./helpers/effect";

async function alarmDefinition(): Promise<Bundle.CapabilityDefinition<"alarm">> {
  const capability = await runEffect(
    Bundle.alarmCapability({
      bundles: [],
      compose: Core.composeAlarmPurposes,
      arm: () => () => Effect.die(new Error("unused arm")),
      watch: { install: () => Effect.void },
    }),
  );
  return capability.definition;
}

test("the manifest is THE product list: alarm capability, monitor and cron bundles, empty off by default", async () => {
  const manifest = appManifest({ alarm: await alarmDefinition(), wake: { close: () => undefined } });
  expect(manifest.capabilities.map((capability) => capability.name)).toEqual(["tool", "alarm"]);
  expect(manifest.bundles.map((bundle) => bundle.name)).toEqual(["monitor", "cron"]);
  expect(manifest.off).toEqual([]);
});

test("the Owner's bundles-off tuple flows through as the manifest off list", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    off: ["monitor"],
  });
  expect(manifest.off).toEqual(["monitor"]);
});

test("a duplicate off name is refused as typed manifest data, not silently deduped", async () => {
  const alarm = await alarmDefinition();
  expect(() => appManifest({ alarm, wake: { close: () => undefined }, off: ["cron", "cron"] })).toThrow(
    Bundle.DefineRefused,
  );
});
