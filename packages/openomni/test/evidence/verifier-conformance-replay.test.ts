/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  CommutativeEventSchema,
  EnvironmentFingerprintInputSchema,
  EnvironmentFingerprintSchema,
  InterleavingPlanSchema,
  InterleavingReportSchema,
  JsonValueSchema,
  NondeterminismManifestSchema,
  RecordedCommandSchema,
  RedactedIdentifierSchema,
  ReplayBindingSchema,
  ReplayConformanceError,
  ReplayDivergenceSchema,
  ReplayKeySchema,
  ReplayTraceSchema,
  Sha256DigestSchema,
  UpcasterSchema,
  VersionedEventSchema,
  assertReplayConformance,
  canonicalJson,
  createEnvironmentFingerprint,
  createReplayKey,
  hashCanonicalJson,
  hashNondeterminismManifest,
  upcastOnRead,
} from "../../src/evidence/verifier-conformance";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const identifiers = {
  runtimeIdentifiers: ["version:bun-1.3.6", "ref:os/darwin-arm64"],
  dependencyIdentifiers: [digestA, "version:zod-3.22.4"],
  environmentIdentifiers: ["ref:locale/en-US", "ref:timezone/UTC"],
};

function captureConformanceError(action: () => unknown): ReplayConformanceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ReplayConformanceError) return error;
    throw error;
  }
  throw new Error("expected ReplayConformanceError");
}

describe("verifier replay identity and schema conformance", () => {
  test("canonicalizes JSON deterministically and rejects non-JSON values", () => {
    expect(canonicalJson({ z: [3, { b: true, a: null }], a: "value" })).toBe(
      '{"a":"value","z":[3,{"a":null,"b":true}]}',
    );
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(hashCanonicalJson({ a: 1, b: 2 }));
    expect(hashCanonicalJson({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => hashCanonicalJson({ absent: undefined })).toThrow();
    expect(() => hashCanonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => hashCanonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => canonicalJson(["\u0000".repeat(1_048_576), "\u0000".repeat(1_048_576)])).toThrow();
  });

  test("rejects unsafe integer aliases in every public conformance schema", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const divergenceBase = {
      version: "replay-divergence-v1",
      kind: "command_mismatch",
    };
    expect(ReplayDivergenceSchema.safeParse({ ...divergenceBase, index: unsafe }).success).toBe(
      false,
    );
    expect(ReplayDivergenceSchema.safeParse({ ...divergenceBase, seed: unsafe }).success).toBe(
      false,
    );
    expect(ReplayDivergenceSchema.safeParse({ ...divergenceBase, iteration: unsafe }).success).toBe(
      false,
    );
    expect(
      VersionedEventSchema.safeParse({
        eventType: "event",
        meaning: "stable",
        schemaVersion: unsafe,
        payload: null,
      }).success,
    ).toBe(false);
    expect(
      UpcasterSchema.safeParse({
        eventType: "event",
        meaning: "stable",
        fromVersion: unsafe,
        toVersion: unsafe,
        upcast: (event: unknown) => event,
      }).success,
    ).toBe(false);
    expect(
      InterleavingReportSchema.safeParse({
        seed: unsafe,
        iterations: unsafe,
        baselineHash: digestA,
        interleavingHashes: [],
      }).success,
    ).toBe(false);
    expect(() =>
      InterleavingPlanSchema.safeParse({
        seed: unsafe,
        iterations: 1,
        initialFold: null,
        events: [],
      }),
    ).not.toThrow();
    expect(
      InterleavingPlanSchema.safeParse({
        seed: unsafe,
        iterations: 1,
        initialFold: null,
        events: [],
      }).success,
    ).toBe(false);
  });

  test("rejects callback-bearing inputs before every JSON-only public schema reads them", async () => {
    const binding = {
      version: "replay-key-v1",
      source: {
        kind: "cassette",
        cassetteIdentifier: "ref:cassette",
        digest: digestA,
      },
      environmentFingerprint: digestA,
      schemaVersion: "version:1",
      upcastVersion: "version:1",
      nondeterminismManifestHash: digestA,
    };
    let getterCalls = 0;
    const accessorBinding = {
      ...binding,
      get version() {
        getterCalls += 1;
        return "replay-key-v1";
      },
    };
    expect(ReplayBindingSchema.safeParse(accessorBinding).success).toBe(false);
    expect(() => createReplayKey(accessorBinding)).toThrow();
    expect(getterCalls).toBe(0);

    const replayKey = createReplayKey(binding);
    const environmentFingerprint = createEnvironmentFingerprint(identifiers);
    for (const [schema, input] of [
      [JsonValueSchema, { value: 1 }],
      [Sha256DigestSchema, {}],
      [RedactedIdentifierSchema, {}],
      [EnvironmentFingerprintInputSchema, identifiers],
      [EnvironmentFingerprintSchema, environmentFingerprint],
      [NondeterminismManifestSchema, { version: "nondeterminism-manifest-v1", entries: [] }],
      [ReplayBindingSchema, binding],
      [ReplayKeySchema, replayKey],
      [ReplayTraceSchema, { commands: [], finalFold: null }],
      [ReplayDivergenceSchema, { version: "replay-divergence-v1", kind: "missing_command" }],
      [RecordedCommandSchema, { command: null, output: null }],
      [
        VersionedEventSchema,
        { eventType: "event", meaning: "stable", schemaVersion: 1, payload: null },
      ],
      [
        UpcasterSchema,
        {
          eventType: "event",
          meaning: "stable",
          fromVersion: 1,
          toVersion: 2,
          upcast: (event: unknown) => event,
        },
      ],
      [CommutativeEventSchema, { id: "event", value: null }],
      [InterleavingPlanSchema, { seed: 1, iterations: 1, initialFold: null, events: [] }],
      [
        InterleavingReportSchema,
        { seed: 1, iterations: 1, baselineHash: digestA, interleavingHashes: [] },
      ],
    ] as const) {
      let trapCalls = 0;
      const proxy = new Proxy(input, {
        get() {
          trapCalls += 1;
          throw new Error("must not run");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("must not run");
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error("must not run");
        },
      });
      expect(schema.safeParse(proxy).success).toBe(false);
      expect((await schema.safeParseAsync(proxy)).success).toBe(false);
      expect(() => schema.parse(proxy)).toThrow();
      expect(trapCalls).toBe(0);
    }

    let inheritedCalls = 0;
    const hostilePrototype: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      eventType: "event",
      meaning: "stable",
      fromVersion: 1,
      toVersion: 2,
      upcast: (event: unknown) => event,
    })) {
      Object.defineProperty(hostilePrototype, key, {
        enumerable: true,
        get() {
          inheritedCalls += 1;
          return value;
        },
      });
    }
    const prototypeAlias = {};
    Object.defineProperty(prototypeAlias, "__proto__", {
      enumerable: true,
      value: hostilePrototype,
    });
    expect(UpcasterSchema.safeParse(prototypeAlias).success).toBe(false);
    expect((await UpcasterSchema.safeParseAsync(prototypeAlias)).success).toBe(false);
    expect(() => UpcasterSchema.parse(prototypeAlias)).toThrow();
    expect(inheritedCalls).toBe(0);

    for (const key of ["eventType", "meaning", "fromVersion", "toVersion", "upcast"] as const) {
      let nestedCalls = 0;
      const nested =
        key === "upcast"
          ? new Proxy(() => undefined, {
              get() {
                nestedCalls += 1;
                throw new Error("must not run");
              },
            })
          : new Proxy(
              {},
              {
                get() {
                  nestedCalls += 1;
                  throw new Error("must not run");
                },
              },
            );
      expect(
        UpcasterSchema.safeParse({
          eventType: "event",
          meaning: "stable",
          fromVersion: 1,
          toVersion: 2,
          upcast: (event: unknown) => event,
          [key]: nested,
        }).success,
      ).toBe(false);
      expect(nestedCalls).toBe(0);
    }

    const hostileList = [
      {
        eventType: "event",
        meaning: "stable",
        fromVersion: 1,
        toVersion: 2,
        upcast: (event: unknown) => event,
      },
    ];
    let listCalls = 0;
    Object.defineProperty(hostileList, "extra", {
      get() {
        listCalls += 1;
        return "must not run";
      },
    });
    expect(() =>
      upcastOnRead(
        { eventType: "event", meaning: "stable", schemaVersion: 1, payload: null },
        2,
        hostileList,
      ),
    ).toThrow();
    expect(listCalls).toBe(0);
  });

  test("creates order-independent runtime, dependency, and environment fingerprints", () => {
    const first = createEnvironmentFingerprint(identifiers);
    const second = createEnvironmentFingerprint({
      runtimeIdentifiers: [...identifiers.runtimeIdentifiers].reverse(),
      dependencyIdentifiers: [...identifiers.dependencyIdentifiers].reverse(),
      environmentIdentifiers: [...identifiers.environmentIdentifiers].reverse(),
    });

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.fingerprint).toBe(
      hashCanonicalJson({
        version: first.version,
        runtimeFingerprint: first.runtimeFingerprint,
        dependencyFingerprint: first.dependencyFingerprint,
        environmentFingerprint: first.environmentFingerprint,
      }),
    );
    expect(first).toMatchObject({
      version: "environment-fingerprint-v1",
      runtimeFingerprint: expect.stringMatching(/^sha256:/),
      dependencyFingerprint: expect.stringMatching(/^sha256:/),
      environmentFingerprint: expect.stringMatching(/^sha256:/),
      fingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(EnvironmentFingerprintSchema.safeParse({ ...first, fingerprint: digestB }).success).toBe(
      false,
    );
    expect(() =>
      createEnvironmentFingerprint({
        ...identifiers,
        environmentIdentifiers: ["raw-secret-value"],
      }),
    ).toThrow();
  });

  test("hashes the ordered nondeterminism manifest", () => {
    const manifest = {
      version: "nondeterminism-manifest-v1",
      entries: [
        { kind: "clock", identifier: "ref:clock/created-at", value: 1_700_000_000 },
        { kind: "ordering", identifier: "ref:scheduler/seed", value: 42 },
      ],
    };

    expect(hashNondeterminismManifest(manifest)).toBe(hashNondeterminismManifest(manifest));
    expect(hashNondeterminismManifest(manifest)).not.toBe(
      hashNondeterminismManifest({ ...manifest, entries: [...manifest.entries].reverse() }),
    );
  });

  test("creates an immutable replay key bound to every replay-of-record input", () => {
    const environment = createEnvironmentFingerprint(identifiers);
    const binding = {
      version: "replay-key-v1",
      source: {
        kind: "range",
        archiveIdentifier: "ref:archive/work-1",
        fromSequence: 10,
        toSequence: 20,
        digest: digestA,
      },
      environmentFingerprint: environment.fingerprint,
      schemaVersion: "ledger-schema-v3",
      upcastVersion: "ledger-upcast-v2",
      nondeterminismManifestHash: digestB,
    };
    const key = createReplayKey(binding);

    expect(key.replayKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.isFrozen(key.source)).toBe(true);
    expect(createReplayKey(binding)).toEqual(key);
    expect(createReplayKey({ ...binding, upcastVersion: "ledger-upcast-v3" }).replayKey).not.toBe(
      key.replayKey,
    );
    expect(
      createReplayKey({
        ...binding,
        source: { ...binding.source, digest: digestB },
      }).replayKey,
    ).not.toBe(key.replayKey);
    expect(ReplayKeySchema.safeParse({ ...key, replayKey: digestB }).success).toBe(false);
    expect(
      ReplayBindingSchema.safeParse({
        ...binding,
        source: {
          ...binding.source,
          fromSequence: Number.MAX_SAFE_INTEGER + 1,
          toSequence: Number.MAX_SAFE_INTEGER + 1,
        },
      }).success,
    ).toBe(false);
  });

  test("compares exact commands and final fold with first-divergence facts", () => {
    const expected = {
      commands: [
        { op: "read", id: 1 },
        { op: "emit", id: 2 },
      ],
      finalFold: { n: 2 },
    };
    expect(assertReplayConformance(expected, expected)).toBeUndefined();

    const mismatch = captureConformanceError(() =>
      assertReplayConformance(expected, {
        commands: [
          { id: 1, op: "read" },
          { op: "emit", id: 3 },
        ],
        finalFold: { n: 2 },
      }),
    );
    expect(mismatch.facts).toMatchObject({ kind: "command_mismatch", index: 1 });
    expect(mismatch.message).toContain("command_mismatch at command 1");

    const missing = captureConformanceError(() =>
      assertReplayConformance(expected, {
        commands: expected.commands.slice(0, 1),
        finalFold: { n: 2 },
      }),
    );
    expect(missing.facts).toMatchObject({ kind: "missing_command", index: 1 });

    const fold = captureConformanceError(() =>
      assertReplayConformance(expected, {
        commands: expected.commands,
        finalFold: { n: 3 },
      }),
    );
    expect(fold.facts).toMatchObject({ kind: "final_fold_mismatch" });
  });

  test("upcasts on read through every version and rejects gaps or re-meaning", () => {
    const event = {
      eventType: "counter.changed",
      meaning: "counter-delta",
      schemaVersion: 1,
      payload: { delta: 2 },
    };
    const upcasted = upcastOnRead(event, 3, [
      {
        eventType: "counter.changed",
        meaning: "counter-delta",
        fromVersion: 1,
        toVersion: 2,
        upcast: (current) => ({
          ...current,
          schemaVersion: 2,
          payload: { delta: 2, source: "legacy" },
        }),
      },
      {
        eventType: "counter.changed",
        meaning: "counter-delta",
        fromVersion: 2,
        toVersion: 3,
        upcast: (current) => ({ ...current, schemaVersion: 3 }),
      },
    ]);
    expect(upcasted).toEqual({
      eventType: "counter.changed",
      meaning: "counter-delta",
      schemaVersion: 3,
      payload: { delta: 2, source: "legacy" },
    });
    expect(Object.isFrozen(upcasted)).toBe(true);
    expect(() =>
      upcastOnRead(event, 3, [
        {
          eventType: "counter.changed",
          meaning: "counter-delta",
          fromVersion: 2,
          toVersion: 3,
          upcast: (current) => ({ ...current, schemaVersion: 3 }),
        },
      ]),
    ).toThrow("upcast gap at version 1");
    expect(() =>
      upcastOnRead(event, 2, [
        {
          eventType: "counter.changed",
          meaning: "counter-delta",
          fromVersion: 1,
          toVersion: 2,
          upcast: (current) => ({
            ...current,
            meaning: "absolute-counter",
            schemaVersion: 2,
          }),
        },
      ]),
    ).toThrow("re-meaning");
  });

  test("bounds aggregate replay traces before comparison", () => {
    const commands = Array.from({ length: 1_025 }, (_, index) => ({ op: "read", index }));
    expect(() =>
      assertReplayConformance({ commands, finalFold: null }, { commands, finalFold: null }),
    ).toThrow();
  });
});
