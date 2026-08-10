import { describe, expect, test } from "bun:test";
import { Stakes } from "@openomni/openomni/ledger";
import { runStakesDriver } from "../harness/stakes-driver.js";
import { stakesDriverStatus } from "../harness/stakes-driver-scenarios.js";
import { registerStakesBoundaryCases } from "./stakes-boundary-cases.js";
import { registerStakesContractCases } from "./stakes-contract-cases.js";
import { registerStakesIdentityCases } from "./stakes-identity-cases.js";
import { registerStakesSeamBindingCases } from "./stakes-seam-binding-cases.js";
import { registerStakesSeamCases } from "./stakes-seam-cases.js";
import { registerStakesSeamRequestCases } from "./stakes-seam-request-cases.js";
import { registerStakesTreatmentCases } from "./stakes-treatment-cases.js";

registerStakesContractCases();
registerStakesBoundaryCases();
registerStakesSeamCases();
registerStakesSeamBindingCases();
registerStakesSeamRequestCases();
registerStakesIdentityCases();
registerStakesTreatmentCases();

describe("Stakes driver", () => {
  test("correlates scenario failure status and result codes", () => {
    expect(stakesDriverStatus("threshold-and-split", false)).toEqual({
      scenario: "threshold-and-split",
      ok: false,
      resultCode: "threshold_and_split_failed",
    });
    expect(stakesDriverStatus("forged-local-value", false)).toEqual({
      scenario: "forged-local-value",
      ok: false,
      resultCode: "forged_local_value_reached_seam",
    });
  });

  test("publishes complete machine-readable happy and hostile receipts", () => {
    const happy = runStakesDriver(["--scenario", "threshold-and-split", "--json"]);
    const hostile = runStakesDriver(["--scenario", "forged-local-value", "--json"]);
    const invalid = runStakesDriver(["--scenario", "unknown", "--json"]);

    expect(happy.exitCode).toBe(0);
    const happyReceipt = JSON.parse(happy.stdout);
    expect(happyReceipt).toMatchObject({
      mode: "scenario",
      scenario: "threshold-and-split",
      ok: true,
      resultCode: "threshold_and_split_verified",
      archivedInputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      amountDenomination: "owner_base_budget_micro_unit",
      theta: Stakes.Theta,
      epsilon: Stakes.Epsilon,
      boundaries: {
        minus: {
          value: Stakes.Theta - Stakes.Epsilon,
          comparison: "below",
          replayCount: 2,
          replayEqual: true,
        },
        equal: {
          value: Stakes.Theta,
          comparison: "at",
          replayCount: 2,
          replayEqual: true,
        },
        plus: {
          value: Stakes.Theta + Stakes.Epsilon,
          comparison: "above",
          replayCount: 2,
          replayEqual: true,
        },
      },
      split: { axesEqual: true, valueEqual: true, comparisonEqual: true },
    });
    expect(happyReceipt.seams.kernelReference).toBe(happyReceipt.seams.completionReference);
    expect(happyReceipt.seams.kernelReference).toBe(happyReceipt.seams.voiceReference);

    expect(hostile.exitCode).toBe(0);
    const hostileReceipt = JSON.parse(hostile.stdout);
    expect(hostileReceipt).toMatchObject({
      mode: "scenario",
      scenario: "forged-local-value",
      ok: true,
      resultCode: "forged_local_value_denied",
      archivedInputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      amountDenomination: "owner_base_budget_micro_unit",
      completionDenial: { code: "forged_local_value", surface: "work.complete.pre" },
      voiceDenial: { code: "forged_local_value", surface: "authorized_voice" },
      forgedValueReachedCompletion: false,
      forgedValueReachedVoice: false,
      localRecomputeReachedCompletion: false,
      localRecomputeReachedVoice: false,
      foreignBrokerTokenReachedCompletion: false,
    });
    expect(hostileReceipt.kernelReferenceBefore).toBe(hostileReceipt.kernelReferenceAfter);
    expect(hostileReceipt.originalCompletionReferenceBefore).toBe(
      hostileReceipt.kernelReferenceBefore,
    );
    expect(hostileReceipt.originalCompletionReferenceAfter).toBe(
      hostileReceipt.kernelReferenceBefore,
    );
    expect(hostileReceipt.originalVoiceReferenceBefore).toBe(hostileReceipt.kernelReferenceBefore);
    expect(hostileReceipt.originalVoiceReferenceAfter).toBe(hostileReceipt.kernelReferenceBefore);

    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    });
  });

  test("returns deterministic help and typed boundary failure receipts", () => {
    const help = runStakesDriver(["--help"]);
    const hostileArguments = new Proxy<readonly string[]>([], {
      get() {
        throw new Error("hostile argument list");
      },
    });
    const failure = runStakesDriver(hostileArguments);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toBe(
      "Usage: stakes-driver --scenario <threshold-and-split|forged-local-value> --json",
    );
    expect(failure.exitCode).toBe(1);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      mode: "driver_error",
      ok: false,
      resultCode: "driver_threw",
    });
  });
});
