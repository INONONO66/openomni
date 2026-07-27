/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { Stakes } from "../../src/evidence";

const DAY = Stakes.WINDOW_MS;
const AS_OF_DB_MS = DAY * 10;

function effect(overrides: Partial<Stakes.ObservedEffectFactV1> = {}): Stakes.ObservedEffectFactV1 {
  return {
    ownerKey: "owner-a",
    ledgerSeq: 10,
    dbCommittedAtMs: AS_OF_DB_MS,
    effectId: "effect-1",
    impactClass: "external_write_or_connector_submit",
    targetId: "target-a",
    nonlocalTarget: true,
    driverId: "connector.submit",
    driverVersion: "v1",
    unknownPossible: true,
    ...overrides,
  };
}

function reduce(observedEffects: readonly Stakes.ObservedEffectFactV1[], overrides = {}) {
  return Stakes.reduce({
    ownerKey: "owner-a",
    asOfLedgerSeq: 100,
    asOfDbMs: AS_OF_DB_MS,
    observedEffects,
    ...overrides,
  });
}

describe("Stakes stakes-v1", () => {
  test("freezes the exported policy namespace without changing its constants", () => {
    expect(Object.isFrozen(Stakes)).toBe(true);

    const mutableView = Stakes as unknown as { THRESHOLD: number };
    expect(() => {
      mutableView.THRESHOLD = 1;
    }).toThrow(TypeError);

    expect(Stakes.REF_VERSION).toBe("stakes-ref-v1");
    expect(Stakes.STAKES_VERSION).toBe("stakes-v1");
    expect(Stakes.WINDOW_MS).toBe(86_400_000);
    expect(Stakes.THRESHOLD).toBe(1000);

    const result = reduce([effect()]);
    expect(result.value).toBe(1000);
    expect(Stakes.isHighStakes(result)).toBe(true);
  });
  test("freezes the approved integer weights and caps", () => {
    expect(Stakes.IMPACT_WEIGHTS).toEqual({
      projection: 0,
      internal_process: 100,
      human_or_existing_actor_message: 200,
      external_read: 250,
      schedule_mutation: 200,
      external_write_or_connector_submit: 400,
      device_or_world_control: 700,
    });
    expect(Stakes.IMPACT_CAP).toBe(1000);
    expect(Stakes.BREADTH_PER_NONLOCAL_TARGET).toBe(250);
    expect(Stakes.BREADTH_CAP).toBe(250);
    expect(Stakes.IRREVERSIBILITY_WEIGHT).toBe(350);
    expect(Stakes.THRESHOLD).toBe(1000);
  });
  test("C1 boundary is exactly 400 impact + 250 breadth + 350 irreversibility", () => {
    const result = reduce([effect()]);
    expect(result).toEqual({
      version: "stakes-ref-v1",
      stakesVersion: "stakes-v1",
      asOfLedgerSeq: 100,
      asOfDbMs: AS_OF_DB_MS,
      value: 1000,
      threshold: 1000,
    });
    expect(Stakes.isHighStakes(result)).toBe(true);
  });

  test("split effects accumulate instead of reducing total impact", () => {
    const unsplit = reduce([
      effect({
        effectId: "unsplit",
        impactClass: "external_write_or_connector_submit",
        nonlocalTarget: false,
        unknownPossible: false,
      }),
    ]);
    const split = reduce([
      effect({
        effectId: "split-1",
        impactClass: "schedule_mutation",
        nonlocalTarget: false,
        unknownPossible: false,
      }),
      effect({
        effectId: "split-2",
        ledgerSeq: 11,
        impactClass: "schedule_mutation",
        nonlocalTarget: false,
        unknownPossible: false,
      }),
    ]);
    expect(split.value).toBe(unsplit.value);
    expect(split.value).toBe(400);
  });

  test("impact accumulation and distinct-target breadth use their frozen caps", () => {
    const result = reduce([
      effect({ effectId: "a", targetId: "target-a", impactClass: "device_or_world_control" }),
      effect({
        effectId: "b",
        ledgerSeq: 11,
        targetId: "target-b",
        impactClass: "device_or_world_control",
        unknownPossible: false,
      }),
    ]);
    expect(result.value).toBe(1000 + 250 + 350);
  });

  test("owner and ledger horizons isolate observations", () => {
    const result = reduce([
      effect({ effectId: "included" }),
      effect({ effectId: "other-owner", ownerKey: "owner-b" }),
      effect({ effectId: "future-seq", ledgerSeq: 101 }),
    ]);
    expect(result.value).toBe(1000);
  });

  test("one-day window is lower-exclusive and upper-inclusive with deterministic rollover", () => {
    const atLowerBoundary = effect({
      effectId: "lower",
      dbCommittedAtMs: AS_OF_DB_MS - DAY,
      impactClass: "internal_process",
      nonlocalTarget: false,
      unknownPossible: false,
    });
    const justInside = effect({
      effectId: "inside",
      ledgerSeq: 11,
      dbCommittedAtMs: AS_OF_DB_MS - DAY + 1,
      impactClass: "internal_process",
      nonlocalTarget: false,
      unknownPossible: false,
    });
    const atUpperBoundary = effect({
      effectId: "upper",
      ledgerSeq: 12,
      dbCommittedAtMs: AS_OF_DB_MS,
      impactClass: "internal_process",
      nonlocalTarget: false,
      unknownPossible: false,
    });
    expect(reduce([atLowerBoundary, justInside, atUpperBoundary]).value).toBe(200);
    expect(
      reduce([atLowerBoundary, justInside, atUpperBoundary], {
        asOfDbMs: AS_OF_DB_MS + 1,
      }).value,
    ).toBe(100);
  });

  test("a compensator removes only the irreversibility component", () => {
    expect(reduce([effect({ compensatorVersion: "v1" })]).value).toBe(650);
  });

  test("actor self-report fields are ignored", () => {
    const reported = effect() as Stakes.ObservedEffectFactV1 & {
      actorReportedStakes: number;
      actorReportedReversible: boolean;
    };
    reported.actorReportedStakes = 0;
    reported.actorReportedReversible = true;
    expect(reduce([reported]).value).toBe(1000);
  });

  test.each([
    ["input ownerKey", { ownerKey: 1 }],
    ["empty input ownerKey", { ownerKey: "" }],
    ["as-of ledger sequence", { asOfLedgerSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative as-of ledger sequence", { asOfLedgerSeq: -1 }],
    ["as-of database time", { asOfDbMs: Number.NaN }],
    ["negative as-of database time", { asOfDbMs: -1 }],
    ["observed effects collection", { observedEffects: null }],
  ])("rejects malformed %s", (_label, overrides) => {
    expect(() =>
      Stakes.reduce({
        ownerKey: "owner-a",
        asOfLedgerSeq: 100,
        asOfDbMs: AS_OF_DB_MS,
        observedEffects: [],
        ...overrides,
      } as unknown as Stakes.InputV1),
    ).toThrow(TypeError);
  });

  test.each([
    ["ownerKey", { ownerKey: 1 }],
    ["effectId", { effectId: "" }],
    ["targetId", { targetId: null }],
    ["driverId", { driverId: false }],
    ["driverVersion", { driverVersion: 1 }],
    ["ledgerSeq", { ledgerSeq: 1.5 }],
    ["dbCommittedAtMs", { dbCommittedAtMs: Number.POSITIVE_INFINITY }],
    ["impactClass", { impactClass: "money" }],
    ["nonlocalTarget", { nonlocalTarget: 1 }],
    ["unknownPossible", { unknownPossible: "yes" }],
    ["compensatorVersion", { compensatorVersion: "" }],
  ])("rejects malformed observed effect %s", (_label, overrides) => {
    const malformed = { ...effect(), ...overrides } as unknown as Stakes.ObservedEffectFactV1;
    expect(() => reduce([malformed])).toThrow(TypeError);
  });

  test("rejects a non-object observed effect", () => {
    expect(() => reduce([null as unknown as Stakes.ObservedEffectFactV1])).toThrow(
      "observed effect must be an object",
    );
  });

  test("rejects duplicate effect IDs even when the observations are outside the active horizon", () => {
    expect(() =>
      reduce([
        effect({ effectId: "duplicate", ownerKey: "owner-b" }),
        effect({ effectId: "duplicate", ownerKey: "owner-b", ledgerSeq: 11 }),
      ]),
    ).toThrow("Duplicate observed effectId: duplicate");
  });
});
