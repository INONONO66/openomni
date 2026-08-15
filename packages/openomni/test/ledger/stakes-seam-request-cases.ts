import { describe, expect, test } from "bun:test";
import {
  Stakes,
  type CompletionStakesBinding,
  type StakesAuthorityRequest,
  type VoiceAuthorizationRequest,
  type VoiceStakesBinding,
} from "@openomni/openomni/ledger";
import { boundaryAction, completionBinding, stakesWindow, voiceBinding } from "./stakes-fixture.js";

export function registerStakesSeamRequestCases(): void {
  describe("Stakes authority request sourcing", () => {
    test("maps every completion binding field into the authority request", () => {
      const binding = completionBinding("trusted");
      const captured = issueWithCapturedRequest(binding);
      expect(captured()).toEqual(expectedAuthorityRequest(binding));
    });

    test("maps every Voice binding field into the authority request", () => {
      const binding = voiceBinding("trusted");
      const captured = issueWithCapturedRequest(binding);
      expect(captured()).toEqual(expectedAuthorityRequest(binding));
    });

    test("rejects direct completion and Voice surface mutation", () => {
      const action = boundaryAction("trusted", 50_000_000);
      const state = { window: stakesWindow, actions: [], knownFingerprints: [] };
      const broker = Stakes.createBroker(authorityFor(action, state));
      const completion = completionBinding(action.actionId);
      const voice = voiceBinding(action.actionId);
      expect(
        broker.completion.inject(broker.issuer.issueCompletion(completion), {
          ...completion,
          surface: "authorized_voice",
        }),
      ).toMatchObject({ ok: false, denial: { code: "invalid_subject" } });
      expect(
        broker.voice.inject(broker.issuer.issueVoice(voice), {
          ...voice,
          surface: "work.complete.pre",
        }),
      ).toMatchObject({ ok: false, denial: { code: "invalid_subject" } });
    });
  });
}

function issueWithCapturedRequest(binding: CompletionStakesBinding | VoiceStakesBinding) {
  const action = boundaryAction("trusted", 50_000_000);
  const state = { window: stakesWindow, actions: [], knownFingerprints: [] };
  let captured: StakesAuthorityRequest | undefined;
  const broker = Stakes.createBroker({
    ...authorityFor(action, state),
    read(request) {
      captured = request;
      return {
        action,
        state,
        basisRef: request.basisRef,
        asOfOwnerSeq: request.asOfOwnerSeq,
        ledgerRangeDigest: request.ledgerRangeDigest,
        noveltyBasisDigest: request.noveltyBasisDigest,
      };
    },
  });
  if (binding.surface === "work.complete.pre") {
    broker.issuer.issueCompletion(binding);
  } else {
    broker.issuer.issueVoice(binding);
  }
  return () => captured;
}

function authorityFor(
  action: ReturnType<typeof boundaryAction>,
  state: { window: typeof stakesWindow; actions: never[]; knownFingerprints: never[] },
) {
  return {
    read(request: StakesAuthorityRequest) {
      return {
        action,
        state,
        basisRef: request.basisRef,
        asOfOwnerSeq: request.asOfOwnerSeq,
        ledgerRangeDigest: request.ledgerRangeDigest,
        noveltyBasisDigest: request.noveltyBasisDigest,
      };
    },
    readVoiceAuthorization(request: VoiceAuthorizationRequest) {
      return request;
    },
  };
}

function expectedAuthorityRequest(
  binding: CompletionStakesBinding | VoiceStakesBinding,
): StakesAuthorityRequest {
  return {
    ownerKey: binding.ownerKey,
    actionRef: binding.actionRef,
    windowRef: binding.windowRef,
    asOfOwnerSeq: binding.asOfOwnerSeq,
    calculatorVersion: binding.calculatorVersion,
    basisRef: binding.basisRef,
    ledgerRangeDigest: binding.ledgerRangeDigest,
    noveltyBasisDigest: binding.noveltyBasisDigest,
  };
}
