import { describe, expect, test } from "bun:test";
import {
  Stakes,
  type CompletionStakesBinding,
  type StakesAuthorityPort,
  type StakesAuthorityRequest,
  type StakesAuthoritySnapshot,
  type VoiceAuthorizationRequest,
  type VoiceStakesBinding,
} from "@openomni/openomni/ledger";
import {
  boundaryAction,
  completionBinding,
  stakesDigest,
  stakesWindow,
  voiceBinding,
} from "./stakes-fixture.js";

type CompletionMutation = Readonly<{
  name: string;
  denial: "binding_mismatch" | "invalid_subject";
  apply(binding: CompletionStakesBinding): unknown;
}>;
type VoiceMutation = Readonly<{
  name: string;
  denial: "binding_mismatch" | "invalid_subject";
  apply(binding: VoiceStakesBinding): unknown;
}>;

const completionMutations: readonly CompletionMutation[] = [
  mutation("ownerKey", (binding) => ({ ...binding, ownerKey: "owner:other" })),
  mutation("actionRef", (binding) => ({ ...binding, actionRef: "action:other" })),
  mutation("windowRef", (binding) => ({ ...binding, windowRef: stakesDigest("other-window") })),
  mutation("asOfOwnerSeq", (binding) => ({
    ...binding,
    asOfOwnerSeq: binding.asOfOwnerSeq + 1,
  })),
  mutation(
    "calculatorVersion",
    (binding) => ({
      ...binding,
      calculatorVersion: "stakes-policy-other",
    }),
    "invalid_subject",
  ),
  mutation("basisRef", (binding) => ({ ...binding, basisRef: stakesDigest("other-basis") })),
  mutation("ledgerRangeDigest", (binding) => ({
    ...binding,
    ledgerRangeDigest: stakesDigest("other-ledger-range"),
  })),
  mutation("noveltyBasisDigest", (binding) => ({
    ...binding,
    noveltyBasisDigest: stakesDigest("other-novelty-basis"),
  })),
  mutation("workItemHash", (binding) => ({ ...binding, workItemHash: "wi_other" })),
  mutation("contractRevision", (binding) => ({
    ...binding,
    contractRevision: binding.contractRevision + 1,
  })),
];

const voiceMutations: readonly VoiceMutation[] = [
  ...completionMutations.slice(0, 8).map(({ name, denial, apply }) => ({ name, denial, apply })),
  mutation("evaluationId", (binding) => ({ ...binding, evaluationId: "jester:other" })),
  mutation("authorizationReceiptRef", (binding) => ({
    ...binding,
    authorizationReceiptRef: stakesDigest("other-voice-authorization"),
  })),
];

export function registerStakesSeamBindingCases(): void {
  describe("Stakes seam binding discrimination", () => {
    for (const field of completionMutations) {
      test(`rejects completion ${field.name} mutation`, () => {
        const { authority, completionSubject } = harness();
        const broker = Stakes.createBroker(authority);
        const token = broker.issuer.issueCompletion(completionSubject);
        expect(broker.completion.inject(token, field.apply(completionSubject))).toMatchObject({
          ok: false,
          denial: { code: field.denial, surface: "work.complete.pre" },
        });
      });
    }

    for (const field of voiceMutations) {
      test(`rejects Voice ${field.name} mutation`, () => {
        const { authority, voiceSubject } = harness();
        const broker = Stakes.createBroker(authority);
        const token = broker.issuer.issueVoice(voiceSubject);
        expect(broker.voice.inject(token, field.apply(voiceSubject))).toMatchObject({
          ok: false,
          denial: { code: field.denial, surface: "authorized_voice" },
        });
      });
    }

    for (const field of snapshotMutations()) {
      test(`rejects authoritative snapshot ${field.name} mutation`, () => {
        const { completionSubject } = harness();
        const broker = Stakes.createBroker(authorityWithSnapshotMutation(field.apply));
        expect(() => broker.issuer.issueCompletion(completionSubject)).toThrow();
      });
    }

    for (const field of voiceAuthorizationMutations) {
      test(`rejects Voice authorization ${field.name} mutation`, () => {
        const { action, state, voiceSubject } = harness();
        const broker = Stakes.createBroker({
          ...authorityFor(action, state),
          readVoiceAuthorization(request) {
            return field.apply(request);
          },
        });
        expect(() => broker.issuer.issueVoice(voiceSubject)).toThrow(Stakes.BrokerError);
      });
    }
  });
}

function mutation<T>(
  name: string,
  apply: (binding: T) => unknown,
  denial: "binding_mismatch" | "invalid_subject" = "binding_mismatch",
): Readonly<{ name: string; denial: "binding_mismatch" | "invalid_subject"; apply: typeof apply }> {
  return { name, denial, apply };
}

function harness() {
  const action = boundaryAction("trusted", 50_000_000);
  const state = { window: stakesWindow, actions: [], knownFingerprints: [] };
  return {
    action,
    state,
    authority: authorityFor(action, state),
    completionSubject: completionBinding(action.actionId),
    voiceSubject: voiceBinding(action.actionId),
  };
}

function authorityFor(
  action: ReturnType<typeof boundaryAction>,
  state: ReturnType<typeof harness>["state"],
): StakesAuthorityPort {
  return {
    read(request) {
      return snapshotFor(request, action, state);
    },
    readVoiceAuthorization(request) {
      return request;
    },
  };
}

function authorityWithSnapshotMutation(
  apply: (snapshot: StakesAuthoritySnapshot) => StakesAuthoritySnapshot,
): StakesAuthorityPort {
  const { action, state } = harness();
  return {
    read(request) {
      return apply(snapshotFor(request, action, state));
    },
    readVoiceAuthorization(request) {
      return request;
    },
  };
}

function snapshotFor(
  request: StakesAuthorityRequest,
  action: ReturnType<typeof boundaryAction>,
  state: ReturnType<typeof harness>["state"],
): StakesAuthoritySnapshot {
  return {
    action,
    state,
    basisRef: request.basisRef,
    asOfOwnerSeq: request.asOfOwnerSeq,
    ledgerRangeDigest: request.ledgerRangeDigest,
    noveltyBasisDigest: request.noveltyBasisDigest,
  };
}

function snapshotMutations() {
  const otherWindow = Stakes.createWindow({
    ownerKey: stakesWindow.ownerKey,
    windowId: "window:other",
    openedAt: stakesWindow.openedAt,
    closesAt: stakesWindow.closesAt,
  });
  return [
    mutation("action", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      action: { ...snapshot.action, actionId: "action:other" },
    })),
    mutation("state", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      state: { ...snapshot.state, window: otherWindow },
    })),
    mutation("basisRef", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      basisRef: stakesDigest("snapshot-basis"),
    })),
    mutation("asOfOwnerSeq", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      asOfOwnerSeq: snapshot.asOfOwnerSeq + 1,
    })),
    mutation("ledgerRangeDigest", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      ledgerRangeDigest: stakesDigest("snapshot-ledger-range"),
    })),
    mutation("noveltyBasisDigest", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      noveltyBasisDigest: stakesDigest("snapshot-novelty-basis"),
    })),
  ];
}

const voiceAuthorizationMutations = [
  mutation("ownerKey", (request: VoiceAuthorizationRequest) => ({
    ...request,
    ownerKey: "owner:other",
  })),
  mutation("evaluationId", (request: VoiceAuthorizationRequest) => ({
    ...request,
    evaluationId: "jester:other",
  })),
  mutation("authorizationReceiptRef", (request: VoiceAuthorizationRequest) => ({
    ...request,
    authorizationReceiptRef: stakesDigest("authorization-other"),
  })),
  mutation("actionRef", (request: VoiceAuthorizationRequest) => ({
    ...request,
    actionRef: "action:other",
  })),
  mutation("windowRef", (request: VoiceAuthorizationRequest) => ({
    ...request,
    windowRef: stakesDigest("authorization-window"),
  })),
  mutation("asOfOwnerSeq", (request: VoiceAuthorizationRequest) => ({
    ...request,
    asOfOwnerSeq: request.asOfOwnerSeq + 1,
  })),
] as const;
