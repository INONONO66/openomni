import { describe, expect, test } from "bun:test";
import { Stakes } from "@openomni/openomni/ledger";
import {
  boundaryAction,
  captureComputationError,
  knownFingerprint,
  stakesAction,
  stakesDigest,
  stakesWindow,
  zeroFacts,
} from "./stakes-fixture.js";

export function registerStakesTreatmentCases(): void {
  describe("Stakes criterion treatment", () => {
    test("computes every documented axis from ledger facts", () => {
      const known = stakesDigest("axis:known");
      const action = stakesAction("axis", stakesWindow.windowRef, "owner:469", {
        irreversibleChangeCount: 1,
        externalSurfaceCount: 1,
        spendMicros: 1_999_999,
        budgetReservedMicros: 2_000_000,
        outreachRecipientCount: 1,
        contentFingerprints: [known, stakesDigest("axis:new")],
      });

      const value = Stakes.compute(action, {
        window: stakesWindow,
        actions: [],
        knownFingerprints: [knownFingerprint("owner:469", known)],
      });

      expect(value.axes).toEqual({
        irreversibility: 400,
        externalSurface: 250,
        spend: 1,
        budget: 2,
        outreach: 100,
        novelty: 50,
      });
    });

    test("classifies treatment without admission authority", () => {
      const low = Stakes.compute(
        stakesAction("low", stakesWindow.windowRef, "owner:469", zeroFacts(stakesDigest("known"))),
        {
          window: stakesWindow,
          actions: [],
          knownFingerprints: [knownFingerprint("owner:469", stakesDigest("known"))],
        },
      );
      const high = Stakes.compute(boundaryAction("high", 50_000_000), {
        window: stakesWindow,
        actions: [],
        knownFingerprints: [],
      });

      const verified = Stakes.assessCriterion({ result: "verified", stakes: low });
      expect(verified).toEqual({
        treatment: "eligible_input",
        reason: "verified_input",
        authorizes: false,
      });
      expect(Object.isFrozen(verified)).toBe(true);
      expect(() => Object.assign(verified, { authorizes: true })).toThrow();
      expect(
        Stakes.assessCriterion({
          result: "asserted",
          stakes: low,
          policyAllowsLowAsserted: true,
        }),
      ).toEqual({
        treatment: "residual_risk",
        reason: "low_stakes_asserted",
        authorizes: false,
      });
      expect(Stakes.assessCriterion({ result: "asserted", stakes: low })).toMatchObject({
        treatment: "non_passing",
        authorizes: false,
      });
      expect(Stakes.assessCriterion({ result: "asserted", stakes: high })).toEqual({
        treatment: "owner_required",
        reason: "high_stakes_asserted",
        authorizes: false,
      });
      for (const result of [
        "missing",
        "refuted",
        "inconclusive",
        "invalidated",
        "basis_mismatched",
        "verification_error",
      ] as const) {
        expect(Stakes.assessCriterion({ result, stakes: low })).toMatchObject({
          treatment: "non_passing",
          authorizes: false,
        });
      }
    });

    test("rejects forged references and duplicate ledger actions", () => {
      const action = boundaryAction("integrity", 50_000_000);
      const value = Stakes.compute(action, {
        window: stakesWindow,
        actions: [],
        knownFingerprints: [],
      });

      expect(
        Stakes.Window.safeParse({ ...stakesWindow, windowRef: stakesDigest("forged-window") })
          .success,
      ).toBe(false);
      expect(
        Stakes.Value.safeParse({
          ...value,
          axes: { ...value.axes, novelty: value.axes.novelty + 1 },
        }).success,
      ).toBe(false);
      expect(
        Stakes.WindowedLedgerState.safeParse({
          window: stakesWindow,
          actions: [action, action],
          knownFingerprints: [],
        }).success,
      ).toBe(false);
      expect(
        captureComputationError(() =>
          Stakes.compute(action, {
            window: stakesWindow,
            actions: [{ ...action, ownerKey: "owner:other" }],
            knownFingerprints: [],
          }),
        ),
      ).toEqual({ code: "duplicate_action", actionId: action.actionId });
      expect(
        Stakes.Action.safeParse({
          ...action,
          facts: { ...action.facts, spendDollars: 1 },
        }).success,
      ).toBe(false);
    });

    test("canonicalizes reordered equivalent ledger views", () => {
      const first = stakesAction(
        "order:a",
        stakesWindow.windowRef,
        "owner:469",
        zeroFacts(stakesDigest("order:a")),
      );
      const second = stakesAction(
        "order:b",
        stakesWindow.windowRef,
        "owner:469",
        zeroFacts(stakesDigest("order:b")),
      );
      const candidate = stakesAction(
        "order:c",
        stakesWindow.windowRef,
        "owner:469",
        zeroFacts(stakesDigest("order:c")),
      );
      const knownA = knownFingerprint("owner:469", stakesDigest("known:a"));
      const knownB = knownFingerprint("owner:469", stakesDigest("known:b"));

      const ordered = Stakes.compute(candidate, {
        window: stakesWindow,
        actions: [first, second],
        knownFingerprints: [knownA, knownB],
      });
      const reversed = Stakes.compute(candidate, {
        window: stakesWindow,
        actions: [second, first],
        knownFingerprints: [knownB, knownA],
      });

      expect(Stakes.serialize(reversed)).toBe(Stakes.serialize(ordered));
    });
  });
}
