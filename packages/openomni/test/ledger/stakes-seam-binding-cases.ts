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
import {
  mutation,
  sharedBindingMutations,
  type BindingMutation,
} from "./stakes-seam-shared-mutations.js";

type CompletionMutation = BindingMutation<CompletionStakesBinding>;
type VoiceMutation = BindingMutation<VoiceStakesBinding>;
type LedgerStateFixture = StakesAuthoritySnapshot["state"];

/** Like mutation(), but keeps the concrete snapshot type so the mutated value can flow back through the typed authority port. */
function snapshotMutation(
  name: string,
  apply: (snapshot: StakesAuthoritySnapshot) => StakesAuthoritySnapshot,
): Readonly<{ name: string; apply(snapshot: StakesAuthoritySnapshot): StakesAuthoritySnapshot }> {
  return { name, apply };
}

/** Like mutation(), but keeps the concrete request type for the voice-authorization read path. */
function voiceAuthorizationMutation(
  name: string,
  apply: (request: VoiceAuthorizationRequest) => VoiceAuthorizationRequest,
): Readonly<{
  name: string;
  apply(request: VoiceAuthorizationRequest): VoiceAuthorizationRequest;
}> {
  return { name, apply };
}

const completionMutations: readonly CompletionMutation[] = [
  ...sharedBindingMutations,
  mutation("workItemHash", (binding) => ({ ...binding, workItemHash: "wi_other" })),
  mutation("requestId", (binding) => ({ ...binding, requestId: "request_other" })),
  mutation("contractRevision", (binding) => ({
    ...binding,
    contractRevision: `${binding.contractRevision}:other`,
  })),
  mutation("expectedHead", (binding) => ({
    ...binding,
    expectedHead: binding.expectedHead + 1,
  })),
];

const voiceMutations: readonly VoiceMutation[] = [
  ...sharedBindingMutations,
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

function harness() {
  const action = boundaryAction("trusted", 50_000_000);
  const state: LedgerStateFixture = { window: stakesWindow, actions: [], knownFingerprints: [] };
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
  state: LedgerStateFixture,
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
  state: LedgerStateFixture,
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
    snapshotMutation("action", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      action: { ...snapshot.action, actionId: "action:other" },
    })),
    snapshotMutation("state", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      action: { ...snapshot.action, windowRef: otherWindow.windowRef },
      state: { ...snapshot.state, window: otherWindow },
    })),
    snapshotMutation("basisRef", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      basisRef: stakesDigest("snapshot-basis"),
    })),
    snapshotMutation("asOfOwnerSeq", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      asOfOwnerSeq: snapshot.asOfOwnerSeq + 1,
    })),
    snapshotMutation("ledgerRangeDigest", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      ledgerRangeDigest: stakesDigest("snapshot-ledger-range"),
    })),
    snapshotMutation("noveltyBasisDigest", (snapshot: StakesAuthoritySnapshot) => ({
      ...snapshot,
      noveltyBasisDigest: stakesDigest("snapshot-novelty-basis"),
    })),
  ];
}

const voiceAuthorizationMutations = [
  voiceAuthorizationMutation("ownerKey", (request: VoiceAuthorizationRequest) => ({
    ...request,
    ownerKey: "owner:other",
  })),
  voiceAuthorizationMutation("evaluationId", (request: VoiceAuthorizationRequest) => ({
    ...request,
    evaluationId: "jester:other",
  })),
  voiceAuthorizationMutation("authorizationReceiptRef", (request: VoiceAuthorizationRequest) => ({
    ...request,
    authorizationReceiptRef: stakesDigest("authorization-other"),
  })),
  voiceAuthorizationMutation("actionRef", (request: VoiceAuthorizationRequest) => ({
    ...request,
    actionRef: "action:other",
  })),
  voiceAuthorizationMutation("windowRef", (request: VoiceAuthorizationRequest) => ({
    ...request,
    windowRef: stakesDigest("authorization-window"),
  })),
  voiceAuthorizationMutation("asOfOwnerSeq", (request: VoiceAuthorizationRequest) => ({
    ...request,
    asOfOwnerSeq: request.asOfOwnerSeq + 1,
  })),
] as const;
