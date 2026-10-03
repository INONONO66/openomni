import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { Alarm } from "@openomni/protocol";
import { AlarmComposeError, composeAlarmPurposes } from "../../../src/core/alarm";
import {
  AlarmWakeError,
  ArmRefused,
  type AlarmFired,
  type AlarmWakeContext,
  type ArmVerb,
} from "../../../src/core/api";
import {
  alarmCapability,
  MONITOR_HIT,
  MONITOR_SOURCE,
  MONITOR_TIMEOUT,
  watchPurposes,
  WatchRefused,
  type AlarmCapabilityDefinition,
  type WatchWakeDeps,
} from "../../../src/plugins/alarm";

// #1254 P1: the removable alarm capability — purpose registry through Lane
// 1's compose, wake dispatch, the watch handlers over the supersedes
// lifecycle (no epoch), and the guarded arm/watch verbs. Pure functions and
// stubbed AlarmWakeContext; Lane 4 wires the live dispatch.

type ArmCall = Parameters<ArmVerb>[0];

function stubArm(calls: ArmCall[], refuse?: ArmRefused): ArmVerb {
  return (input) => {
    if (refuse !== undefined) return Effect.fail(refuse);
    calls.push(input);
    return Effect.succeed({
      alarmId: input.alarmId ?? "minted-alarm",
      occurrenceId: `occ-${calls.length}`,
    });
  };
}

function stubContext(input: {
  readonly arm: ArmVerb;
  readonly latestArm?: { readonly occurrenceId: string; readonly at: number | null };
}): AlarmWakeContext {
  return {
    sessionId: "session-1",
    reads: { latestArm: () => input.latestArm, settled: () => false },
    arm: input.arm,
    now: 5_000,
  };
}

function fired(input: Partial<AlarmFired> & { readonly payload: string }): AlarmFired {
  return {
    occurrenceId: "occ-live",
    purpose: MONITOR_HIT,
    alarmId: "watch-1",
    armSeq: 7,
    sourceKey: MONITOR_SOURCE,
    fireAt: 4_000,
    ...input,
  };
}

const spec: Alarm.WatchSpec = {
  watch: { command: "tail -f log", description: "log watch", persistent: true },
  policyGeneration: 1,
  notificationLimit: 2,
};

interface PromptCall {
  readonly content: string;
  readonly purpose: string;
}

function wakeDeps(prompts: PromptCall[], closed: string[]): WatchWakeDeps {
  return {
    prompt: ({ content, fired: wake }) =>
      Effect.sync(() => {
        prompts.push({ content, purpose: wake.purpose });
      }),
    close: (watchId) => closed.push(watchId),
  };
}

function capability(input: {
  readonly arm: ArmVerb;
  readonly prompts?: PromptCall[];
  readonly closed?: string[];
  readonly installs?: string[];
  readonly extra?: readonly { readonly bundle: string; readonly purposes: readonly string[] }[];
}): AlarmCapabilityDefinition {
  const deps = wakeDeps(input.prompts ?? [], input.closed ?? []);
  return Effect.runSync(
    alarmCapability({
      bundles: [
        { bundle: "monitor", purposes: watchPurposes(deps) },
        ...(input.extra ?? []).map((declaration) => ({
          bundle: declaration.bundle,
          purposes: declaration.purposes.map((name) => ({
            name,
            handler: () => Effect.succeed("delivered" as const),
          })),
        })),
      ],
      compose: composeAlarmPurposes,
      arm: input.arm,
      watch: {
        install: ({ watchId }) =>
          Effect.sync(() => {
            (input.installs ?? []).push(watchId);
          }),
      },
    }),
  );
}

describe("purpose registry through composeAlarmPurposes", () => {
  test("a reserved purpose declaration refuses the whole capability", () => {
    const build = alarmCapability({
      bundles: [
        {
          bundle: "rogue",
          purposes: [{ name: "retry", handler: () => Effect.succeed("delivered" as const) }],
        },
      ],
      compose: composeAlarmPurposes,
      arm: stubArm([]),
      watch: { install: () => Effect.void },
    });
    const error = Effect.runSync(Effect.flip(build));
    expect(error).toBeInstanceOf(AlarmComposeError);
    expect(error.code).toBe("reserved_purpose");
    expect(error.bundle).toBe("rogue");
  });

  test("a duplicate purpose across bundles refuses with the duplicating bundle", () => {
    const build = alarmCapability({
      bundles: [
        {
          bundle: "monitor",
          purposes: watchPurposes(wakeDeps([], [])),
        },
        {
          bundle: "copycat",
          purposes: [{ name: MONITOR_HIT, handler: () => Effect.succeed("delivered" as const) }],
        },
      ],
      compose: composeAlarmPurposes,
      arm: stubArm([]),
      watch: { install: () => Effect.void },
    });
    const error = Effect.runSync(Effect.flip(build));
    expect(error.code).toBe("duplicate_purpose");
    expect(error.bundle).toBe("copycat");
  });

  test("the composed definition names its registry, point, and declared purposes", () => {
    const definition = capability({ arm: stubArm([]), extra: [{ bundle: "cron", purposes: ["cron.tick"] }] });
    expect(definition.name).toBe("alarm");
    expect(definition.points).toEqual(["alarm.fired"]);
    expect([...definition.purposes].sort()).toEqual(["cron.tick", MONITOR_HIT, MONITOR_TIMEOUT].sort());
    expect(definition.registry.get(MONITOR_HIT)).toBe("monitor");
    expect(definition.registry.get("cron.tick")).toBe("cron");
    expect(definition.registry.get("retry")).toBe("core");
  });
});

describe("wake dispatch", () => {
  test("routes a fired occurrence to its registered handler", () => {
    const prompts: PromptCall[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls), prompts });
    const outcome = Effect.runSync(
      definition.wake(
        fired({
          payload: JSON.stringify({
            spec,
            notifications: 0,
            hit: { content: "line one", terminal: false, detail: "line:1" },
          }),
        }),
        stubContext({ arm: stubArm(calls) }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(prompts).toEqual([{ content: "line one", purpose: MONITOR_HIT }]);
  });

  test("an unregistered purpose is a typed wake failure with zero handler calls", () => {
    const prompts: PromptCall[] = [];
    const definition = capability({ arm: stubArm([]), prompts });
    const error = Effect.runSync(
      Effect.flip(
        definition.wake(
          fired({ purpose: "reminder.due", payload: "{}" }),
          stubContext({ arm: stubArm([]) }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(AlarmWakeError);
    expect(error.reason).toBe("unregistered_purpose");
    expect(prompts).toEqual([]);
  });
});

describe("monitor.hit over the supersedes lifecycle", () => {
  test("a non-terminal hit under budget prompts and re-arms superseding the fired occurrence", () => {
    const prompts: PromptCall[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), prompts });
    const outcome = Effect.runSync(
      definition.wake(
        fired({
          payload: JSON.stringify({
            spec: { ...spec, notificationLimit: 3 },
            notifications: 0,
            hit: { content: "tick", terminal: false, detail: "line:1" },
          }),
        }),
        stubContext({ arm: stubArm(calls) }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: MONITOR_HIT,
      at: 5_000,
      alarmId: "watch-1",
      supersedes: "occ-live",
      sourceKey: MONITOR_SOURCE,
      payload: { notifications: 1 },
    });
  });

  test("budget exhaustion returns exhausted and retires the chain", () => {
    const prompts: PromptCall[] = [];
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), prompts, closed });
    const outcome = Effect.runSync(
      definition.wake(
        fired({
          payload: JSON.stringify({
            spec,
            notifications: 1,
            hit: { content: "last", terminal: false, detail: "line:2" },
          }),
        }),
        stubContext({ arm: stubArm(calls) }),
      ),
    );
    expect(outcome).toBe("exhausted");
    expect(calls).toEqual([
      {
        purpose: MONITOR_HIT,
        at: null,
        alarmId: "watch-1",
        supersedes: "occ-live",
        sourceKey: MONITOR_SOURCE,
        payload: { reason: "exhausted" },
      },
    ]);
    expect(closed).toEqual(["watch-1"]);
    expect(prompts).toHaveLength(1);
  });

  test("a terminal hit retires the chain and closes the source", () => {
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), closed });
    const outcome = Effect.runSync(
      definition.wake(
        fired({
          payload: JSON.stringify({
            spec,
            notifications: 0,
            hit: { content: "exit 0", terminal: true, detail: "exit" },
          }),
        }),
        stubContext({ arm: stubArm(calls) }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(calls[0]).toMatchObject({ at: null, payload: { reason: "fired" } });
    expect(closed).toEqual(["watch-1"]);
  });

  test("a hit without native detail is a typed wake failure", () => {
    const definition = capability({ arm: stubArm([]) });
    const error = Effect.runSync(
      Effect.flip(
        definition.wake(
          fired({ payload: JSON.stringify({ spec, notifications: 0 }) }),
          stubContext({ arm: stubArm([]) }),
        ),
      ),
    );
    expect(error.reason).toBe("missing_hit");
  });

  test("an arm refusal during re-arm surfaces as a typed wake failure", () => {
    const definition = capability({ arm: stubArm([]) });
    const error = Effect.runSync(
      Effect.flip(
        definition.wake(
          fired({
            payload: JSON.stringify({
              spec: { ...spec, notificationLimit: 3 },
              notifications: 0,
              hit: { content: "tick", terminal: false, detail: "line:1" },
            }),
          }),
          stubContext({ arm: stubArm([], new ArmRefused({ code: "alarm_budget" })) }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(AlarmWakeError);
    expect(error.reason).toBe("alarm_budget");
  });
});

describe("monitor.timeout", () => {
  test("prompts, retires the main chain through the chain reads, and closes the source", () => {
    const prompts: PromptCall[] = [];
    const closed: string[] = [];
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]), prompts, closed });
    const outcome = Effect.runSync(
      definition.wake(
        fired({
          purpose: MONITOR_TIMEOUT,
          alarmId: "watch-1:timeout",
          payload: JSON.stringify({ watchId: "watch-1" }),
        }),
        stubContext({
          arm: stubArm(calls),
          latestArm: { occurrenceId: "occ-main", at: 4_500 },
        }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(calls).toEqual([
      {
        purpose: MONITOR_HIT,
        at: null,
        alarmId: "watch-1",
        supersedes: "occ-main",
        sourceKey: MONITOR_SOURCE,
        payload: { reason: "timeout" },
      },
    ]);
    expect(closed).toEqual(["watch-1"]);
    expect(JSON.parse(prompts[0]?.content ?? "{}")).toEqual({
      watchId: "watch-1",
      reason: "timeout",
    });
  });

  test("an already retired chain lapses without a superseding arm", () => {
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm([]) });
    const outcome = Effect.runSync(
      definition.wake(
        fired({
          purpose: MONITOR_TIMEOUT,
          alarmId: "watch-1:timeout",
          payload: JSON.stringify({ watchId: "watch-1" }),
        }),
        stubContext({ arm: stubArm(calls), latestArm: { occurrenceId: "occ-main", at: null } }),
      ),
    );
    expect(outcome).toBe("delivered");
    expect(calls).toEqual([]);
  });
});

describe("verbs", () => {
  test("watch arms the chain, arms the timeout alarm, and installs the native source", () => {
    const calls: ArmCall[] = [];
    const installs: string[] = [];
    const definition = capability({ arm: stubArm(calls), installs });
    const timed: Alarm.WatchSpec = {
      ...spec,
      watch: { command: "make build", description: "build watch", timeout_ms: 60_000 },
    };
    const result = Effect.runSync(
      definition.verbs.watch({ sessionId: "session-1", watchId: "watch-9", spec: timed, now: 1_000 }),
    );
    expect(result).toEqual({ alarmId: "watch-9", occurrenceId: "occ-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      purpose: MONITOR_HIT,
      at: 1_000,
      alarmId: "watch-9",
      sourceKey: MONITOR_SOURCE,
      payload: { notifications: 0 },
    });
    expect(calls[1]).toMatchObject({
      purpose: MONITOR_TIMEOUT,
      at: 61_000,
      alarmId: "watch-9:timeout",
      payload: { watchId: "watch-9" },
    });
    expect(installs).toEqual(["watch-9"]);
  });

  test("an invalid watch spec is a typed refusal with zero arms", () => {
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls) });
    const broken = {
      ...spec,
      watch: { command: "", description: "broken", persistent: true },
    } as Alarm.WatchSpec;
    const error = Effect.runSync(
      Effect.flip(
        definition.verbs.watch({ sessionId: "session-1", watchId: "w", spec: broken, now: 0 }),
      ),
    );
    expect(error).toBeInstanceOf(WatchRefused);
    expect(calls).toEqual([]);
  });

  test("arm refuses reserved, rescan, and unregistered purposes before the commit path", () => {
    const calls: ArmCall[] = [];
    const definition = capability({ arm: stubArm(calls) });
    const refused = (purpose: string) =>
      Effect.runSync(
        Effect.flip(
          definition.verbs.arm({ purpose, at: 1, payload: {}, sourceKey: "monitor" }),
        ),
      );
    expect(refused("retry").code).toBe("reserved_purpose");
    expect(refused("rescan").code).toBe("reserved_purpose");
    expect(refused("reminder.due").code).toBe("unknown_purpose");
    expect(calls).toEqual([]);
    const accepted = Effect.runSync(
      definition.verbs.arm({
        purpose: MONITOR_HIT,
        at: 2,
        payload: {},
        alarmId: "watch-2",
        sourceKey: MONITOR_SOURCE,
      }),
    );
    expect(accepted.alarmId).toBe("watch-2");
    expect(calls).toHaveLength(1);
  });
});
