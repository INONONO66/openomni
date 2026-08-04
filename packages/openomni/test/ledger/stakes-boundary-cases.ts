import { describe, expect, test } from "bun:test";
import { Stakes } from "@openomni/openomni/ledger";
import { boundaryAction, stakesDigest, stakesWindow } from "./stakes-fixture.js";

export function registerStakesBoundaryCases(): void {
  describe("Stakes hostile boundaries", () => {
    test("rejects proxies and accessors without invoking traps", () => {
      const valid = boundaryAction("hostile", 1);
      let proxyTrapCount = 0;
      const proxy = new Proxy(valid, {
        get() {
          proxyTrapCount += 1;
          throw new Error("proxy get trap executed");
        },
        ownKeys() {
          proxyTrapCount += 1;
          throw new Error("proxy ownKeys trap executed");
        },
      });
      expect(() => Stakes.compute(proxy, state())).toThrow();
      expect(proxyTrapCount).toBe(0);

      let getterCount = 0;
      const accessor = { ...valid };
      Object.defineProperty(accessor, "actionId", {
        enumerable: true,
        get() {
          getterCount += 1;
          return "accessor";
        },
      });
      expect(() => Stakes.compute(accessor, state())).toThrow();
      expect(getterCount).toBe(0);
    });

    test("rejects cyclic, sparse, symbolic, and custom-prototype input", () => {
      const cyclic: Record<string, unknown> = { ...state() };
      cyclic.self = cyclic;
      expect(() => Stakes.compute(boundaryAction("cycle", 1), cyclic)).toThrow();

      const sparseActions = new Array(1);
      expect(() =>
        Stakes.compute(boundaryAction("sparse", 1), {
          ...state(),
          actions: sparseActions,
        }),
      ).toThrow();

      const symbolic = { ...boundaryAction("symbolic", 1) };
      Object.defineProperty(symbolic, Symbol("hidden"), { value: true });
      expect(() => Stakes.compute(symbolic, state())).toThrow();

      const customPrototype = Object.create({ inherited: true });
      Object.assign(customPrototype, boundaryAction("prototype", 1));
      expect(() => Stakes.compute(customPrototype, state())).toThrow();
    });

    test("rejects unsafe, non-finite, and negative-zero numbers", () => {
      for (const spendMicros of [Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, -0]) {
        expect(() =>
          Stakes.compute(
            {
              ...boundaryAction("number", 1),
              facts: { ...boundaryAction("number", 1).facts, spendMicros },
            },
            state(),
          ),
        ).toThrow();
      }
    });

    test("keeps kernel validation isolated from public schema mutation", () => {
      const original = Object.getOwnPropertyDescriptor(Stakes.Action, "safeParse");
      if (original === undefined) throw new Error("expected public Stakes.Action.safeParse method");
      const oversized = {
        ...boundaryAction("oversized", 1),
        facts: {
          ...boundaryAction("oversized", 1).facts,
          spendMicros: 1_000_000_000_001,
        },
      };
      try {
        Object.defineProperty(Stakes.Action, "safeParse", {
          ...original,
          value: () => ({ success: true, data: oversized }),
        });
        expect(Stakes.Action.safeParse(oversized).success).toBe(true);
        expect(() => Stakes.compute(oversized, state())).toThrow();
      } finally {
        Object.defineProperty(Stakes.Action, "safeParse", original);
      }
    });
  });
}

function state() {
  return {
    window: stakesWindow,
    actions: [],
    knownFingerprints: [
      {
        ownerKey: stakesWindow.ownerKey,
        fingerprint: stakesDigest("known"),
        firstObservedAt: stakesWindow.openedAt,
      },
    ],
  };
}
