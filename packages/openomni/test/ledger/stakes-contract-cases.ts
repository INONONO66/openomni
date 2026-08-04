import { describe, expect, test } from "bun:test";
import { Stakes } from "@openomni/openomni/ledger";
import {
  boundaryAction,
  captureComputationError,
  highFacts,
  knownFingerprint,
  stakesAction,
  stakesDigest,
  stakesWindow,
  zeroFacts,
} from "./stakes-fixture.js";

export function registerStakesContractCases(): void {
  describe("Stakes", () => {
    test("computes stable theta boundaries from ledger facts", () => {
      const state = Stakes.WindowedLedgerState.parse({
        window: stakesWindow,
        actions: [],
        knownFingerprints: [],
      });

      const below = Stakes.compute(boundaryAction("below", 49_000_000), state);
      const at = Stakes.compute(boundaryAction("at", 50_000_000), state);
      const above = Stakes.compute(boundaryAction("above", 51_000_000), state);
      const replayed = Stakes.compute(boundaryAction("at", 50_000_000), state);

      expect([below.value, at.value, above.value]).toEqual([
        Stakes.Theta - Stakes.Epsilon,
        Stakes.Theta,
        Stakes.Theta + Stakes.Epsilon,
      ]);
      expect([below.comparison, at.comparison, above.comparison]).toEqual(["below", "at", "above"]);
      expect(Object.keys(at.axes).sort()).toEqual([
        "budget",
        "externalSurface",
        "irreversibility",
        "novelty",
        "outreach",
        "spend",
      ]);
      expect(Stakes.Value.parse(at)).toEqual(at);
      expect(Stakes.serialize(replayed)).toBe(Stakes.serialize(at));
    });

    test("makes heterogeneous split actions equal their composition", () => {
      const first = stakesAction("split:1", stakesWindow.windowRef, "owner:469", {
        irreversibleChangeCount: 1,
        externalSurfaceCount: 1,
        spendMicros: 400_000,
        budgetReservedMicros: 200_000,
        outreachRecipientCount: 1,
        contentFingerprints: [stakesDigest("a")],
      });
      const second = stakesAction("split:2", stakesWindow.windowRef, "owner:469", {
        irreversibleChangeCount: 1,
        externalSurfaceCount: 0,
        spendMicros: 600_000,
        budgetReservedMicros: 800_000,
        outreachRecipientCount: 1,
        contentFingerprints: [stakesDigest("b")],
      });
      const composed = stakesAction("composed", stakesWindow.windowRef, "owner:469", {
        irreversibleChangeCount: 2,
        externalSurfaceCount: 1,
        spendMicros: 1_000_000,
        budgetReservedMicros: 1_000_000,
        outreachRecipientCount: 2,
        contentFingerprints: [stakesDigest("a"), stakesDigest("b")],
      });

      const split = Stakes.compute(second, {
        window: stakesWindow,
        actions: [first],
        knownFingerprints: [],
      });
      const whole = Stakes.compute(composed, {
        window: stakesWindow,
        actions: [],
        knownFingerprints: [],
      });

      expect(split.axes).toEqual(whole.axes);
      expect(split.value).toBe(whole.value);
      expect(split.comparison).toBe(whole.comparison);
    });

    test("isolates owners and rollover windows", () => {
      const oldWindow = Stakes.createWindow({
        ownerKey: "owner:469",
        windowId: "window:old",
        openedAt: 0,
        closesAt: 1_000,
      });
      const candidate = stakesAction(
        "candidate",
        stakesWindow.windowRef,
        "owner:469",
        zeroFacts(stakesDigest("candidate")),
      );
      const polluted = Stakes.compute(candidate, {
        window: stakesWindow,
        actions: [
          stakesAction(
            "other-owner",
            stakesWindow.windowRef,
            "owner:other",
            highFacts(stakesDigest("other")),
          ),
          {
            ...stakesAction(
              "old-window",
              oldWindow.windowRef,
              "owner:469",
              highFacts(stakesDigest("old")),
            ),
            ledgerObservedAt: 500,
          },
        ],
        knownFingerprints: [knownFingerprint("owner:other", stakesDigest("candidate"))],
      });
      const isolated = Stakes.compute(candidate, {
        window: stakesWindow,
        actions: [],
        knownFingerprints: [],
      });

      expect(polluted).toEqual(isolated);
    });

    test("uses half-open windows and typed mismatch failures", () => {
      const state = { window: stakesWindow, actions: [], knownFingerprints: [] };
      const included = {
        ...stakesAction(
          "last",
          stakesWindow.windowRef,
          "owner:469",
          zeroFacts(stakesDigest("last")),
        ),
        ledgerObservedAt: stakesWindow.closesAt - 1,
      };
      const excluded = {
        ...included,
        actionId: "next",
        ledgerObservedAt: stakesWindow.closesAt,
      };

      expect(Stakes.compute(included, state).window.windowId).toBe(stakesWindow.windowId);
      expect(captureComputationError(() => Stakes.compute(excluded, state))).toEqual({
        code: "candidate_outside_window",
        actionId: "next",
      });
    });
  });
}
