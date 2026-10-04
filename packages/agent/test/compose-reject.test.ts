import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { z } from "zod";
import type { PlainValue, PointId } from "@openomni/protocol";
import {
  Capability,
  defineBundle,
  Manifest,
  type BundleContract,
  type BundleGateRow,
  type CapabilityDefinition,
  type SeamTag,
} from "../src/core/capability";
import { compose, COMPOSE_REJECTION_CODES, ComposeRefused } from "../src/core/compose";

class SeamA extends Context.Service<SeamA, object>()("@openomni/agent/test/compose/A") {}
class SeamB extends Context.Service<SeamB, object>()("@openomni/agent/test/compose/B") {}
class SeamGhost extends Context.Service<SeamGhost, object>()("@openomni/agent/test/compose/Ghost") {}

const kind = {
  schema: z.object({}),
  version: 1 as const,
  reduce: (state: PlainValue) => state,
};

function capability(
  name: string,
  seam: SeamTag,
  overrides: {
    requires?: readonly string[];
    kinds?: Readonly<Record<string, typeof kind>>;
    points?: readonly PointId[];
    handlers?: Readonly<Record<string, object>>;
  } = {},
): CapabilityDefinition {
  return Capability.define({
    name,
    requires: overrides.requires ?? [],
    kinds: overrides.kinds,
    points: overrides.points,
    handlers: overrides.handlers,
    verbs: {},
    seam,
  });
}

const row = (id: string, on: PointId, ref?: string): BundleGateRow => ({
  id,
  on,
  when: {},
  do: "gate",
  how: ref === undefined ? { verdict: "allow" } : { ref },
  order: 1,
});

async function rejectionOf(manifest: Parameters<typeof compose>[0]): Promise<ComposeRefused> {
  const refused = await Effect.runPromise(Effect.flip(compose(manifest)));
  expect(refused).toBeInstanceOf(ComposeRefused);
  return refused;
}

test("the compose rejection set is closed at exactly six codes", () => {
  expect(COMPOSE_REJECTION_CODES).toEqual([
    "requires_cycle",
    "duplicate",
    "product_declares_kind",
    "seam_missing",
    "unknown_handler",
    "unknown_point",
  ]);
});

test("requires_cycle: mutually requiring capabilities reject", async () => {
  const manifest = Manifest.define({
    capabilities: [
      capability("a", SeamA, { requires: ["b"] }),
      capability("b", SeamB, { requires: ["a"] }),
    ],
    bundles: [],
  });
  expect((await rejectionOf(manifest)).code).toBe("requires_cycle");
});

test("requires_cycle: bundles providing each other's requires reject", async () => {
  const manifest = Manifest.define({
    capabilities: [],
    bundles: [
      defineBundle({ name: "m", requires: [SeamA], provides: [SeamB] }),
      defineBundle({ name: "n", requires: [SeamB], provides: [SeamA] }),
    ],
  });
  expect((await rejectionOf(manifest)).code).toBe("requires_cycle");
});

test("duplicate: a colliding kind, point, tool or row id rejects", async () => {
  const kinds = await rejectionOf(
    Manifest.define({
      capabilities: [
        capability("a", SeamA, { kinds: { probe: kind } }),
        capability("b", SeamB, { kinds: { probe: kind } }),
      ],
      bundles: [],
    }),
  );
  expect(kinds.code).toBe("duplicate");
  const points = await rejectionOf(
    Manifest.define({
      capabilities: [
        capability("a", SeamA, { points: ["alarm.fired"] }),
        capability("b", SeamB, { points: ["alarm.fired"] }),
      ],
      bundles: [],
    }),
  );
  expect(points.code).toBe("duplicate");
  const rows = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { points: ["alarm.fired"] })],
      bundles: [
        defineBundle({ name: "m", requires: [SeamA], rows: [row("m/x#1", "alarm.fired")] }),
        defineBundle({ name: "n", requires: [SeamA], rows: [row("m/x#1", "alarm.fired")] }),
      ],
    }),
  );
  expect(rows.code).toBe("duplicate");
});

test("product_declares_kind: a bundle carrying a capability-owned table rejects", async () => {
  const smuggled = {
    ...defineBundle({ name: "m", requires: [] }),
    kinds: { probe: kind },
  } as BundleContract;
  const refused = await rejectionOf(Manifest.define({ capabilities: [], bundles: [smuggled] }));
  expect(refused.code).toBe("product_declares_kind");
  expect(refused.name).toBe("m");
});

test("seam_missing: an unknown seam rejects — it is not a deactivation", async () => {
  const missingCapability = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { requires: ["ghost"] })],
      bundles: [],
    }),
  );
  expect(missingCapability.code).toBe("seam_missing");
  const missingBundleSeam = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA)],
      bundles: [defineBundle({ name: "m", requires: [SeamGhost] })],
    }),
  );
  expect(missingBundleSeam.code).toBe("seam_missing");
  expect(missingBundleSeam.detail).toBe("@openomni/agent/test/compose/Ghost");
});

test("unknown_handler: a row referencing an unregistered how.ref rejects", async () => {
  const refused = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { handlers: { "a/known": {} } })],
      bundles: [
        defineBundle({ name: "m", requires: [SeamA], rows: [row("m/x#1", "turn.pre", "a/ghost")] }),
      ],
    }),
  );
  expect(refused.code).toBe("unknown_handler");
  expect(refused.detail).toBe("a/ghost");
});

test("unknown_point: a row on an off or absent capability's point rejects", async () => {
  const absent = await rejectionOf(
    Manifest.define({
      capabilities: [],
      bundles: [defineBundle({ name: "m", requires: [], rows: [row("m/x#1", "alarm.fired")] })],
    }),
  );
  expect(absent.code).toBe("unknown_point");
  const off = await rejectionOf(
    Manifest.define({
      capabilities: [capability("a", SeamA, { points: ["alarm.fired"] })],
      bundles: [defineBundle({ name: "m", requires: [], rows: [row("m/x#1", "alarm.fired")] })],
      off: ["a"],
    }),
  );
  expect(off.code).toBe("unknown_point");
});

test("a valid manifest composes one generation with merged tables and a stable hash", async () => {
  const manifest = Manifest.define({
    capabilities: [
      capability("a", SeamA, { points: ["alarm.fired"], kinds: { probe: kind }, handlers: { "a/guard": {} } }),
      capability("b", SeamB, { requires: ["a"] }),
    ],
    bundles: [
      defineBundle({
        name: "m",
        requires: [SeamA, SeamB],
        rows: [row("m/x#1", "alarm.fired", "a/guard"), row("m/y#1", "turn.pre")],
      }),
    ],
  });
  const generation = await Effect.runPromise(compose(manifest));
  expect(generation.capabilities).toEqual(["a", "b"]);
  expect(generation.bundles).toEqual(["m"]);
  expect(Object.keys(generation.kinds)).toEqual(["probe"]);
  expect(generation.points).toContain("alarm.fired");
  expect(generation.points).toContain("turn.pre");
  expect(generation.handlers.has("a/guard")).toBe(true);
  expect(generation.rows.map((entry) => entry.id)).toEqual(["m/x#1", "m/y#1"]);
  expect(generation.disabled).toEqual([]);
  const again = await Effect.runPromise(compose(manifest));
  expect(again.hash).toBe(generation.hash);
});
