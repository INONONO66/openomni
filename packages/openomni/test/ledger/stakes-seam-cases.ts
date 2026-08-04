import { describe, expect, test } from "bun:test";
import {
  Stakes,
  type StakesAuthorityRequest,
  type VoiceAuthorizationRequest,
} from "@openomni/openomni/ledger";
import {
  boundaryAction,
  completionBinding,
  stakesDigest,
  stakesWindow,
  voiceBinding,
} from "./stakes-fixture.js";

export function registerStakesSeamCases(): void {
  describe("Stakes guarded seams", () => {
    test("rejects self-report and every local replacement", () => {
      const action = boundaryAction("trusted", 50_000_000);
      const state = { window: stakesWindow, actions: [], knownFingerprints: [] };
      const computed = Stakes.compute(action, state);
      const forged = JSON.parse(Stakes.serialize(computed));
      const recomputed = Stakes.compute(action, state);
      const completionSubject = completionBinding("trusted");
      const voiceSubject = voiceBinding("trusted");
      const authority = {
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
      const broker = Stakes.createBroker(authority);
      const foreignBroker = Stakes.createBroker(authority);
      const staleBroker = Stakes.createBroker({
        ...authority,
        read(request) {
          return { ...authority.read(request), asOfOwnerSeq: request.asOfOwnerSeq + 1 };
        },
      });
      const unauthorizedVoiceBroker = Stakes.createBroker({
        ...authority,
        readVoiceAuthorization(request) {
          return {
            ...request,
            authorizationReceiptRef: stakesDigest("unrecognized-voice-authorization"),
          };
        },
      });
      const completionToken = broker.issuer.issueCompletion(completionSubject);
      const voiceToken = broker.issuer.issueVoice(voiceSubject);
      const foreignToken = foreignBroker.issuer.issueCompletion(completionSubject);
      let bindingTrapCount = 0;
      const hostileBinding = new Proxy(completionSubject, {
        ownKeys() {
          bindingTrapCount += 1;
          throw new Error("binding trap executed");
        },
      });

      const completion = broker.completion.inject(completionToken, completionSubject);
      const voice = broker.voice.inject(voiceToken, voiceSubject);
      const forgedCompletion = broker.completion.inject(forged, completionSubject);
      const forgedVoice = broker.voice.inject(forged, voiceSubject);

      expect(completion).toMatchObject({ ok: true, context: { surface: "work.complete.pre" } });
      expect(voice).toMatchObject({ ok: true, context: { surface: "authorized_voice" } });
      if (!completion.ok || !voice.ok) throw new Error("expected issued Stakes contexts");
      expect(Object.keys(completion.context).sort()).toEqual(["stakes", "surface", "workItemHash"]);
      expect(Object.keys(voice.context).sort()).toEqual([
        "authorizationReceiptRef",
        "evaluationId",
        "stakes",
        "surface",
      ]);
      expect(Stakes.serialize(completion.context.stakes)).toBe(
        Stakes.serialize(voice.context.stakes),
      );
      expect(forgedCompletion).toEqual({
        ok: false,
        denial: { code: "forged_local_value", surface: "work.complete.pre" },
      });
      expect(forgedVoice).toEqual({
        ok: false,
        denial: { code: "forged_local_value", surface: "authorized_voice" },
      });
      expect(broker.completion.inject(recomputed, completionSubject)).toEqual(forgedCompletion);
      expect(broker.voice.inject(recomputed, voiceSubject)).toEqual(forgedVoice);
      expect(broker.completion.inject(foreignToken, completionSubject)).toEqual(forgedCompletion);
      expect(broker.completion.inject(completionToken, hostileBinding)).toMatchObject({
        ok: false,
        denial: { code: "invalid_subject" },
      });
      expect(bindingTrapCount).toBe(0);
      expect(broker.voice.inject(completionToken, voiceSubject)).toMatchObject({
        ok: false,
        denial: { code: "surface_mismatch" },
      });
      expect(
        broker.completion.inject(completionToken, {
          ...completionSubject,
          workItemHash: "wi_transplant",
        }),
      ).toMatchObject({ ok: false, denial: { code: "binding_mismatch" } });
      expect(() => staleBroker.issuer.issueCompletion(completionSubject)).toThrow(
        Stakes.BrokerError,
      );
      expect(() => unauthorizedVoiceBroker.issuer.issueVoice(voiceSubject)).toThrow(
        Stakes.BrokerError,
      );
      expect(
        broker.completion.inject(completionToken, {
          ...completionSubject,
          asOfOwnerSeq: completionSubject.asOfOwnerSeq + 1,
        }),
      ).toMatchObject({ ok: false, denial: { code: "binding_mismatch" } });
      expect(Stakes.Action.safeParse({ ...action, stakes: Stakes.Theta + 1 }).success).toBe(false);
    });
  });
}
