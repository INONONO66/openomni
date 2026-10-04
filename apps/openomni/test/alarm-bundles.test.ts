import { expect, test } from "bun:test";
import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import { CRON_TICK, cronPurposes } from "../src/composition/bundles/cron";
import { monitorPurposes } from "../src/composition/bundles/monitor";
import { runEffect } from "./helpers/effect";

/** A recording `AlarmWakeContext.prompt` — the core's verb, stubbed for assertion. */
function recordingPrompt() {
  const prompts: { content: string; payload?: unknown }[] = [];
  const prompt: Bundle.AlarmPromptVerb = (input) => {
    prompts.push(input);
    return Effect.succeed({ seq: prompts.length });
  };
  return { prompts, prompt };
}

async function composedCapability(): Promise<Bundle.AlarmCapabilityDefinition> {
  return await runEffect(
    Bundle.alarmCapability({
      bundles: [monitorPurposes({ close: () => undefined }), cronPurposes()],
      compose: Core.composeAlarmPurposes,
      arm: () => () => Effect.die(new Error("unused arm")),
      watch: { install: () => Effect.void },
    }),
  );
}

test("alarmCapability composes the monitor and cron purposes under their owning bundles", async () => {
  const capability = await composedCapability();
  // The composed registry binds each product purpose to its declaring bundle.
  expect([...capability.registry.entries()].filter(([, owner]) => owner !== "core")).toEqual([
    ["monitor.hit", "monitor"],
    ["monitor.timeout", "monitor"],
    ["cron.tick", "cron"],
  ]);
});

const cronFired = (payload: unknown, fireAt: number): Bundle.AlarmFired => ({
  occurrenceId: "grid:tick:1",
  purpose: CRON_TICK,
  alarmId: "grid",
  armSeq: 1,
  sourceKey: "cron",
  payload: JSON.stringify(payload),
  fireAt,
});

function cronWake() {
  const { prompts, prompt } = recordingPrompt();
  const arms: Parameters<Bundle.ArmVerb>[0][] = [];
  const declaration = cronPurposes().purposes[0];
  if (declaration === undefined) throw new Error("missing cron purpose");
  const wake = (fired: Bundle.AlarmFired, now: number) =>
    declaration.handler({
      fired,
      ctx: {
        sessionId: "cron-session",
        reads: { latestArm: () => undefined, settled: () => false },
        arm: (input) => {
          arms.push(input);
          return Effect.succeed({
            alarmId: input.alarmId ?? "grid",
            occurrenceId: "occ-next",
            armSeq: arms.length,
          });
        },
        now,
        prompt,
      },
    });
  return { prompts, arms, wake };
}

const payload = { expr: "*/5 * * * *", tz: "UTC", description: "five-minute grid" };

test("cron.tick prompts once and re-arms the chain at the next grid time", async () => {
  const { prompts, arms, wake } = cronWake();
  // On time: fired at 0:05, woken at 0:05 — nothing missed, next tick 0:10.
  expect(await runEffect(wake(cronFired(payload, 300_000), 300_000))).toBe("delivered");
  expect(prompts).toEqual([
    {
      content: JSON.stringify({
        kind: CRON_TICK,
        description: "five-minute grid",
        expr: "*/5 * * * *",
        firedAt: 300_000,
        missed: 0,
      }),
      payload: { expr: "*/5 * * * *", missed: 0 },
    },
  ]);
  expect(arms).toEqual([
    {
      purpose: CRON_TICK,
      at: 600_000,
      alarmId: "grid",
      supersedes: "grid:tick:1",
      sourceKey: "cron",
      payload,
    },
  ]);
  // Downtime: fired at 0:05, woken at 0:20:10 — 0:10, 0:15 and 0:20 elapsed
  // in (fireAt, now]; one prompt carries the count, no catch-up storm.
  expect(await runEffect(wake(cronFired(payload, 300_000), 1_210_000))).toBe("delivered");
  expect(prompts).toHaveLength(2);
  expect(prompts.at(-1)).toMatchObject({ payload: { expr: "*/5 * * * *", missed: 3 } });
  expect(arms.at(-1)).toMatchObject({ at: 1_500_000 });
});

test("cron.tick counts every grid instant lost to downtime: */30 asleep 3h reports missed: 6", async () => {
  const { prompts, arms, wake } = cronWake();
  const half = { expr: "*/30 * * * *", tz: "UTC", description: "half-hour grid" };
  // Issue #1254 line 64: fired at 10:00Z, host slept, woken at 13:00Z. The six
  // elapsed grid instants in (fireAt, now] are 10:30, 11:00, 11:30, 12:00,
  // 12:30 and 13:00 — missed: 6, and the chain re-arms at 13:30.
  const firedAt = Date.UTC(2026, 0, 1, 10, 0);
  const now = Date.UTC(2026, 0, 1, 13, 0);
  expect(await runEffect(wake(cronFired(half, firedAt), now))).toBe("delivered");
  expect(prompts).toEqual([
    {
      content: JSON.stringify({
        kind: CRON_TICK,
        description: "half-hour grid",
        expr: "*/30 * * * *",
        firedAt,
        missed: 6,
      }),
      payload: { expr: "*/30 * * * *", missed: 6 },
    },
  ]);
  expect(arms).toEqual([
    {
      purpose: CRON_TICK,
      at: Date.UTC(2026, 0, 1, 13, 30),
      alarmId: "grid",
      supersedes: "grid:tick:1",
      sourceKey: "cron",
      payload: half,
    },
  ]);
});

test("cron.tick reports payload and expression faults as typed wake failures", async () => {
  const { wake } = cronWake();
  const bad = await runEffect(Effect.flip(wake(cronFired({ not: "cron" }, 300_000), 300_000)));
  expect(bad).toBeInstanceOf(Bundle.AlarmWakeError);
  expect(bad.reason).toBe("payload");
  const expr = await runEffect(
    Effect.flip(wake(cronFired({ ...payload, expr: "not a cron line" }, 300_000), 300_000)),
  );
  expect(expr.reason).toBe("cron_expr");
});
