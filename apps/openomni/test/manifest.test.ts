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

test("the manifest is THE product list: tool/action/hook/alarm capabilities, five bundles, empty off by default", async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
  });
  expect(manifest.capabilities.map((capability) => capability.name)).toEqual([
    "tool",
    "action",
    "hook",
    "alarm",
  ]);
  expect(manifest.bundles.map((bundle) => bundle.name)).toEqual([
    "monitor",
    "cron",
    "hooks-json",
    "send-message",
    "delegation-policy",
  ]);
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
  expect(() =>
    appManifest({ alarm, wake: { close: () => undefined }, off: ["cron", "cron"] }),
  ).toThrow(Bundle.DefineRefused);
});

test('off: ["tool"] composes with a typed cascade: monitor, send-message and delegation-policy disable with because "tool"', async () => {
  const manifest = appManifest({
    alarm: await alarmDefinition(),
    wake: { close: () => undefined },
    off: ["tool"],
  });
  const generation = Bundle.composeSync(manifest);
  expect(generation.disabled).toContainEqual({ name: "tool", because: "tool" });
  expect(generation.disabled).toContainEqual({ name: "monitor", because: "tool" });
  expect(generation.disabled).toContainEqual({ name: "send-message", because: "tool" });
  expect(generation.disabled).toContainEqual({ name: "delegation-policy", because: "tool" });
  expect(generation.rows.map((row) => row.id)).not.toContain("monitor/tool.pre#1");
  expect(generation.rows.filter((row) => row.on === "tool.pre" || row.on === "tool.post")).toEqual([]);
});
