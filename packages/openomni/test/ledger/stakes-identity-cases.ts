import { describe, expect, test } from "bun:test";
import { Stakes } from "@openomni/openomni/ledger";
import { runStakesDriver } from "../harness/stakes-driver.js";
import { hashStakesInputs } from "../../src/ledger/stakes-compute.js";
import {
  boundaryAction,
  stakesAction,
  stakesDigest,
  stakesWindow,
  zeroFacts,
} from "./stakes-fixture.js";

export function registerStakesIdentityCases(): void {
  describe("Stakes replay identities", () => {
    test("freezes representative machine-consumed identities", () => {
      const value = Stakes.compute(boundaryAction("at", 50_000_000), emptyState());
      const knownValue = Stakes.compute(boundaryAction("at", 50_000_000), {
        ...emptyState(),
        knownFingerprints: [knownIdentityFingerprint()],
      });
      const receipt = JSON.parse(
        runStakesDriver(["--scenario", "threshold-and-split", "--json"]).stdout,
      ) as Record<string, unknown>;

      expect(stakesWindow.windowRef).toBe(
        "sha256:c214d9019d155ce38124140605c66284791c90ecc9b2b22d8a556d23d1c01af1",
      );
      expect(value.inputDigest).toBe(
        "sha256:d3999cfad4045c4ccb4e46372a5a1d2791a6e724ab7ad30d389bf271761c545c",
      );
      expect(value.reference).toBe(
        "sha256:e3c1e7f9525f35c9a9e8ec622a61545ac6f4c5e3fc5adbc4d8317652296b8124",
      );
      expect(knownValue.inputDigest).toBe(
        "sha256:80bf10388753511ae6246fb611dabc8fe069b32ec05a10c7bc0405f1ba984aad",
      );
      expect(knownValue.reference).toBe(
        "sha256:e8bf00908d7c7d695bca54b72865c3725b3d0a6f2bc3a691d50344f53055599d",
      );
      expect(receipt.archivedInputDigest).toBe(
        "sha256:1d9d26fe9b1b3d69d4efdabacce0cda7cbd4d4545326cb2886655666de9f78d6",
      );
    });

    test("changes input identity for every material input dimension", () => {
      const action = boundaryAction("identity", 50_000_000);
      const baseline = Stakes.compute(action, emptyState()).inputDigest;
      const actionVariants = [
        { ...action, actionId: "identity:other" },
        { ...action, ledgerObservedAt: action.ledgerObservedAt + 1 },
        withFacts(action, { irreversibleChangeCount: action.facts.irreversibleChangeCount + 1 }),
        withFacts(action, { externalSurfaceCount: action.facts.externalSurfaceCount + 1 }),
        withFacts(action, { spendMicros: action.facts.spendMicros + 1 }),
        withFacts(action, { budgetReservedMicros: action.facts.budgetReservedMicros + 1 }),
        withFacts(action, { outreachRecipientCount: action.facts.outreachRecipientCount + 1 }),
        withFacts(action, { contentFingerprints: [stakesDigest("identity:other")] }),
      ];

      for (const variant of actionVariants) {
        expect(Stakes.compute(variant, emptyState()).inputDigest).not.toBe(baseline);
      }

      const windowInputs = [
        { ownerKey: "owner:other", windowId: "window:primary", openedAt: 1_000, closesAt: 2_000 },
        { ownerKey: "owner:469", windowId: "window:other", openedAt: 1_000, closesAt: 2_000 },
        { ownerKey: "owner:469", windowId: "window:primary", openedAt: 999, closesAt: 2_000 },
        { ownerKey: "owner:469", windowId: "window:primary", openedAt: 1_000, closesAt: 2_001 },
      ] as const;
      for (const windowInput of windowInputs) {
        const window = Stakes.createWindow(windowInput);
        const candidate = { ...action, ownerKey: window.ownerKey, windowRef: window.windowRef };
        expect(
          Stakes.compute(candidate, { window, actions: [], knownFingerprints: [] }).inputDigest,
        ).not.toBe(baseline);
      }

      const prior = stakesAction(
        "prior",
        stakesWindow.windowRef,
        stakesWindow.ownerKey,
        zeroFacts(stakesDigest("prior")),
      );
      expect(Stakes.compute(action, { ...emptyState(), actions: [prior] }).inputDigest).not.toBe(
        baseline,
      );
      expect(
        Stakes.compute(action, {
          ...emptyState(),
          knownFingerprints: [
            {
              ownerKey: stakesWindow.ownerKey,
              fingerprint: stakesDigest("known"),
              firstObservedAt: stakesWindow.openedAt - 1,
            },
          ],
        }).inputDigest,
      ).not.toBe(baseline);
    });

    test("discriminates every known-fingerprint tuple field", () => {
      const action = boundaryAction("identity-known", 50_000_000);
      const known = knownIdentityFingerprint();
      const baseline = hashStakesInputs(stakesWindow, [action], [known]);
      const variants = [
        { ...known, ownerKey: "owner:other" },
        { ...known, fingerprint: stakesDigest("known-other") },
        { ...known, firstObservedAt: known.firstObservedAt - 1 },
      ];

      for (const variant of variants) {
        expect(hashStakesInputs(stakesWindow, [action], [variant])).not.toBe(baseline);
      }
    });
  });
}

function emptyState() {
  return { window: stakesWindow, actions: [], knownFingerprints: [] };
}

function knownIdentityFingerprint() {
  return {
    ownerKey: stakesWindow.ownerKey,
    fingerprint: stakesDigest("known-golden"),
    firstObservedAt: stakesWindow.openedAt - 1,
  };
}

function withFacts(
  action: ReturnType<typeof boundaryAction>,
  facts: Partial<ReturnType<typeof boundaryAction>["facts"]>,
) {
  return { ...action, facts: { ...action.facts, ...facts } };
}
