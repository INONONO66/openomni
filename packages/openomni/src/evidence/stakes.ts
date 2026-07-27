export namespace Stakes {
  export const REF_VERSION = "stakes-ref-v1" as const;
  export const STAKES_VERSION = "stakes-v1" as const;
  export const WINDOW_MS = 86_400_000;
  export const THRESHOLD = 1000;
  export const IMPACT_CAP = 1000;
  export const BREADTH_PER_NONLOCAL_TARGET = 250;
  export const BREADTH_CAP = 250;
  export const IRREVERSIBILITY_WEIGHT = 350;

  export const IMPACT_WEIGHTS = Object.freeze({
    projection: 0,
    internal_process: 100,
    human_or_existing_actor_message: 200,
    external_read: 250,
    schedule_mutation: 200,
    external_write_or_connector_submit: 400,
    device_or_world_control: 700,
  } as const);

  export type ImpactClass = keyof typeof IMPACT_WEIGHTS;

  /** Kernel-observed committed effect-intent facts; actor risk or stakes claims are intentionally absent. */
  export type ObservedEffectFactV1 = Readonly<{
    ownerKey: string;
    ledgerSeq: number;
    dbCommittedAtMs: number;
    effectId: string;
    impactClass: ImpactClass;
    targetId: string;
    nonlocalTarget: boolean;
    driverId: string;
    driverVersion: string;
    unknownPossible: boolean;
    compensatorVersion?: string;
  }>;

  export type InputV1 = Readonly<{
    ownerKey: string;
    asOfLedgerSeq: number;
    asOfDbMs: number;
    observedEffects: readonly ObservedEffectFactV1[];
  }>;

  export type ResultV1 = Readonly<{
    version: typeof REF_VERSION;
    stakesVersion: typeof STAKES_VERSION;
    asOfLedgerSeq: number;
    asOfDbMs: number;
    value: number;
    threshold: typeof THRESHOLD;
  }>;

  /** Reduces committed observations in (asOfDbMs - one day, asOfDbMs], isolated by owner and ledger horizon. */
  export function reduce(input: InputV1): ResultV1 {
    if (typeof input !== "object" || input === null) throw new TypeError("input must be an object");
    assertNonEmptyString(input.ownerKey, "ownerKey");
    assertNonNegativeInteger(input.asOfLedgerSeq, "asOfLedgerSeq");
    assertNonNegativeInteger(input.asOfDbMs, "asOfDbMs");
    if (!Array.isArray(input.observedEffects)) {
      throw new TypeError("observedEffects must be an array");
    }

    const windowStartExclusive = input.asOfDbMs - WINDOW_MS;
    let impact = 0;
    let irreversible = false;
    const nonlocalTargets = new Set<string>();
    const observedEffectIds = new Set<string>();

    for (const effect of input.observedEffects as readonly ObservedEffectFactV1[]) {
      validateEffect(effect);
      if (observedEffectIds.has(effect.effectId)) {
        throw new TypeError(`Duplicate observed effectId: ${effect.effectId}`);
      }
      observedEffectIds.add(effect.effectId);
      if (
        effect.ownerKey !== input.ownerKey ||
        effect.ledgerSeq > input.asOfLedgerSeq ||
        effect.dbCommittedAtMs <= windowStartExclusive ||
        effect.dbCommittedAtMs > input.asOfDbMs
      ) {
        continue;
      }

      impact = Math.min(IMPACT_CAP, impact + IMPACT_WEIGHTS[effect.impactClass]);
      if (effect.nonlocalTarget) nonlocalTargets.add(effect.targetId);
      if (effect.unknownPossible && effect.compensatorVersion === undefined) irreversible = true;
    }

    const breadth = Math.min(BREADTH_CAP, BREADTH_PER_NONLOCAL_TARGET * nonlocalTargets.size);
    const value = impact + breadth + (irreversible ? IRREVERSIBILITY_WEIGHT : 0);
    return Object.freeze({
      version: REF_VERSION,
      stakesVersion: STAKES_VERSION,
      asOfLedgerSeq: input.asOfLedgerSeq,
      asOfDbMs: input.asOfDbMs,
      value,
      threshold: THRESHOLD,
    });
  }

  export function isHighStakes(result: ResultV1): boolean {
    return result.value >= result.threshold;
  }

  function validateEffect(effect: ObservedEffectFactV1): void {
    if (typeof effect !== "object" || effect === null) {
      throw new TypeError("observed effect must be an object");
    }
    assertNonEmptyString(effect.ownerKey, "observed ownerKey");
    assertNonEmptyString(effect.effectId, "effectId");
    assertNonEmptyString(effect.targetId, "targetId");
    assertNonEmptyString(effect.driverId, "driverId");
    assertNonEmptyString(effect.driverVersion, "driverVersion");
    if (Object.getOwnPropertyDescriptor(IMPACT_WEIGHTS, effect.impactClass) === undefined) {
      throw new TypeError(`Unsupported impact class: ${String(effect.impactClass)}`);
    }
    assertNonNegativeInteger(effect.ledgerSeq, "observed ledgerSeq");
    assertNonNegativeInteger(effect.dbCommittedAtMs, "observed dbCommittedAtMs");
    assertBoolean(effect.nonlocalTarget, "nonlocalTarget");
    assertBoolean(effect.unknownPossible, "unknownPossible");
    if (effect.compensatorVersion !== undefined) {
      assertNonEmptyString(effect.compensatorVersion, "compensatorVersion");
    }
  }

  function assertNonNegativeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }

  function assertNonEmptyString(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }

  function assertBoolean(value: unknown, name: string): asserts value is boolean {
    if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  }
}

Object.freeze(Stakes);
