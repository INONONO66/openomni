/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  EnvironmentFingerprintSchema,
  ReplayBindingSchema,
  ReplayConformanceError,
  ReplayKeySchema,
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
