import { describe, expect, test } from "bun:test";
import { Provider } from "@openomni/llm";
import {
  AgentToolProvider,
  InjectionQueue,
  createWorkspaceIdentity,
  toWorkspaceRef,
} from "@openomni/openomni";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { createWorkerGenerationKeySigner } from "../../../../packages/coordinator/src/worker-supervision/supervisor-process";
import {
  createP2WorkerCredentialProvisioner,
  createP2WorkerTransferCredentialRef,
  decodeP2PrivateProvisioningFrame,
  encodeP2PrivateProvisioningFrame,
  describeP2ProvisioningFrame,
  p2ProvisioningAuthenticationTag,
  P2ProvisioningCleanupError,
  P2ProvisioningDeniedError,
  p2ProvisioningBytes,
  P2_PRIVATE_PROVISIONING_FRAME_MAX_BYTES,
  type ProvisionedCredentialMaterial,
  type P2CredentialProvisioningFrame,
  type P2PrivateFdKeyMaterial,
  type P2ProvisioningNonceStore,
  type P2ProvisioningPeerIdentity,
} from "../../src/execution/p2-worker-provisioning";
import { createPinnedWorkerModelCatalog } from "../../src/execution/worker-runtime";
import { WorkerRunner } from "../../src/execution/worker-runner";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const canary = "provider-secret-canary";

function canonicalCredentialRef(input: unknown) {
  const sanitizer = BoundarySanitizer.create();
  const registry = SecretRegistry.create(sanitizer);
  try {
    return registry.register(CredentialSource.parseOwner(input)).ref;
  } finally {
    registry.dispose();
  }
}
const attempt = {
  version: "attempt-ref-v1" as const,
  workItemId: "work-1",
  attemptId: "attempt-1",
  attemptSeq: 1,
};
const credentialRef = canonicalCredentialRef({
  providerId: "openai",
  credentialId: "owner-default",
  rotationId: "rotation-1",
  sourceKind: "injected_runtime",
  auth: { type: "api", key: canary },
});
const request = {
  version: "credential-provisioning-request-v1" as const,
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 7,
  principalId: "principal-1",
  attempt,
  providerIds: ["openai"],
  nonceRef: digest,
  expiresAt: 100,
  credentialRefs: [credentialRef],
};
const peerIdentity: P2ProvisioningPeerIdentity = {
  runtimeId: request.runtimeId,
  workerId: request.workerId,
  generation: request.generation,
  principalId: request.principalId,
  processId: process.pid,
};
const keyText = "private-fd-generation-seven-key-material";

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function credentialSecret(input: P2CredentialProvisioningFrame, index = 0): Uint8Array {
  const credential = required(input.credentials[index], "credential material is missing");
  return required(credential.secret, "credential secret is missing");
}

function nonceStore(consumed = new Set<string>()): P2ProvisioningNonceStore {
  return {
    consume(nonceRef) {
      if (consumed.has(nonceRef)) return false;
      consumed.add(nonceRef);
      return true;
    },
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const key = p2ProvisioningBytes(keyText);
  let disposeCalls = 0;
  const keyMaterial: P2PrivateFdKeyMaterial = {
    take: () => key,
    dispose: () => {
      disposeCalls += 1;
      key.fill(0);
    },
  };
  const receiver = createP2WorkerCredentialProvisioner({
    ...peerIdentity,
    attempt,
    nonceRef: request.nonceRef,
    providerIds: request.providerIds,
    credentialRefs: request.credentialRefs,
    keyMaterial,
    nonces: nonceStore(),
    nowDbMs: () => 50,
    ...overrides,
  });
  return { receiver, key, disposeCalls: () => disposeCalls };
}

function frame(
  overrides: Partial<P2CredentialProvisioningFrame> = {},
): P2CredentialProvisioningFrame {
  const nextRequest = (overrides.request ?? request) as typeof request;
  const nextPeer = overrides.peerIdentity ?? peerIdentity;
  const nextCredentials = overrides.credentials ?? [
    {
      providerId: "openai",
      credentialId: "owner-default",
      authType: "api" as const,
      secret: p2ProvisioningBytes(canary),
    },
  ];
  return {
    request: nextRequest,
    peerIdentity: nextPeer,
    authenticationTag:
      overrides.authenticationTag ??
      p2ProvisioningAuthenticationTag(
        p2ProvisioningBytes(keyText),
        nextRequest,
        nextPeer,
        nextCredentials,
      ),
    credentials: nextCredentials,
  };
}

function expectDenied(
  input: P2CredentialProvisioningFrame,
  overrides: Record<string, unknown> = {},
) {
  const { receiver } = setup(overrides);
  expect(() => receiver.provision(input)).toThrow("credential provisioning denied");
}
function deniedError(
  receiver: ReturnType<typeof setup>["receiver"],
  input: P2CredentialProvisioningFrame,
): P2ProvisioningDeniedError {
  try {
    receiver.provision(input);
  } catch (error) {
    expect(error).toBeInstanceOf(P2ProvisioningDeniedError);
    return error as P2ProvisioningDeniedError;
  }
  throw new Error("expected credential provisioning denial");
}

describe("P2 private credential frame codec", () => {
  test("deterministically roundtrips API and proxy material without losing binary or absence", () => {
    const input = {
      peerIdentity,
      authenticationTag: new Uint8Array(32).map((_, index) => index),
      credentials: [
        {
          providerId: "openai-λ",
          credentialId: "api-default",
          authType: "api" as const,
          secret: new Uint8Array([0, 255, 128, 1]),
        },
        {
          providerId: "proxy-a",
          credentialId: "without-secret",
          authType: "proxy" as const,
          baseURL: "https://proxy.invalid/v1?q=✓",
        },
        {
          providerId: "proxy-b",
          credentialId: "with-secret",
          authType: "proxy" as const,
          baseURL: "https://proxy.invalid/v2",
          secret: new Uint8Array([9, 0, 8]),
        },
      ],
    };

    const first = encodeP2PrivateProvisioningFrame(input);
    const second = encodeP2PrivateProvisioningFrame(input);
    expect(first).toEqual(second);
    expect(decodeP2PrivateProvisioningFrame(first)).toEqual(input);
    expect(
      "secret" in
        required(
          decodeP2PrivateProvisioningFrame(first).credentials[1],
          "decoded proxy credential is missing",
        ),
    ).toBe(false);
  });

  test("decoded authentication detects tag and credential tampering", () => {
    const credentials = frame().credentials;
    const encoded = encodeP2PrivateProvisioningFrame({
      peerIdentity,
      authenticationTag: p2ProvisioningAuthenticationTag(
        p2ProvisioningBytes(keyText),
        request,
        peerIdentity,
        credentials,
      ),
      credentials,
    });
    const tagTamper = encoded.slice();
    let tagOffset = 5;
    for (let field = 0; field < 2; field += 1) {
      const length = Number(new DataView(tagTamper.buffer).getBigUint64(tagOffset));
      tagOffset += 8 + length;
    }
    tagOffset += 8;
    const principalLength = Number(new DataView(tagTamper.buffer).getBigUint64(tagOffset));
    tagOffset += 8 + principalLength + 8;
    tagTamper[tagOffset] ^= 1;
    const decodedTagTamper = decodeP2PrivateProvisioningFrame(tagTamper);
    expectDenied({ request, ...decodedTagTamper });

    const materialTamper = encoded.slice();
    materialTamper[materialTamper.byteLength - 1] ^= 1;
    const decodedMaterialTamper = decodeP2PrivateProvisioningFrame(materialTamper);
    expectDenied({ request, ...decodedMaterialTamper });
  });

  test("rejects truncation, trailing bytes, oversized frames, hostile views, and claimed lengths", () => {
    const encoded = encodeP2PrivateProvisioningFrame({
      peerIdentity,
      authenticationTag: new Uint8Array(32),
      credentials: [],
    });
    const truncated = encoded.slice(0, -1);
    expect(() => decodeP2PrivateProvisioningFrame(truncated)).toThrow(
      "invalid private credential provisioning frame",
    );
    expect(allZero(truncated)).toBe(true);
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    expect(() => decodeP2PrivateProvisioningFrame(trailing)).toThrow(
      "invalid private credential provisioning frame",
    );
    expect(allZero(trailing)).toBe(true);
    expect(() =>
      decodeP2PrivateProvisioningFrame(new Uint8Array(P2_PRIVATE_PROVISIONING_FRAME_MAX_BYTES + 1)),
    ).toThrow("invalid private credential provisioning frame");
    const claimed = encoded.slice();
    new DataView(claimed.buffer).setUint32(5, 0xffff_ffff, false);
    expect(() => decodeP2PrivateProvisioningFrame(claimed)).toThrow(
      "invalid private credential provisioning frame",
    );
    expect(allZero(claimed)).toBe(true);
    let traps = 0;
    const hostile = new Proxy(encoded, {
      get() {
        traps += 1;
        throw new Error(canary);
      },
    });
    expect(() => decodeP2PrivateProvisioningFrame(hostile)).toThrow(
      "invalid private credential provisioning frame",
    );
    expect(traps).toBe(0);
  });

  test("rejects PID substitution in the private frame and scrubs the rejected bytes", () => {
    const substituted = encodeP2PrivateProvisioningFrame({
      peerIdentity: { ...peerIdentity, processId: process.pid + 1 },
      authenticationTag: new Uint8Array(32).fill(9),
      credentials: [
        {
          providerId: "openai",
          credentialId: "owner-default",
          authType: "api",
          secret: p2ProvisioningBytes(canary),
        },
      ],
    });

    expect(() => decodeP2PrivateProvisioningFrame(substituted)).toThrow(
      "invalid private credential provisioning frame",
    );
    expect(allZero(substituted)).toBe(true);
  });

  test("scrubs a malformed frame after copying its tag and a partial credential set", () => {
    const encoded = encodeP2PrivateProvisioningFrame({
      peerIdentity,
      authenticationTag: new Uint8Array(32).fill(7),
      credentials: [
        {
          providerId: "openai",
          credentialId: "owner-default",
          authType: "api",
          secret: p2ProvisioningBytes(canary),
        },
      ],
    });
    const malformed = encoded.slice(0, -1);

    expect(() => decodeP2PrivateProvisioningFrame(malformed)).toThrow(
      "invalid private credential provisioning frame",
    );
    expect(allZero(malformed)).toBe(true);
  });

  test("uses a context-bound signer once and scrubs its generation key", () => {
    const key = new Uint8Array(32).fill(7);
    const expectedKey = key.slice();
    const signer = createWorkerGenerationKeySigner(key, {
      ...peerIdentity,
      attempt,
      processId: process.pid,
    });
    const credentials = frame().credentials;
    const tag = p2ProvisioningAuthenticationTag(signer, request, peerIdentity, credentials);
    expect(tag).toEqual(
      p2ProvisioningAuthenticationTag(expectedKey, request, peerIdentity, credentials),
    );
    expect(allZero(key)).toBe(true);
    expect(() =>
      p2ProvisioningAuthenticationTag(signer, request, peerIdentity, credentials),
    ).toThrow("worker generation key unavailable");

    const wrongProcessSigner = createWorkerGenerationKeySigner(new Uint8Array(32).fill(8), {
      ...peerIdentity,
      attempt,
      processId: 0,
    });
    expect(() =>
      p2ProvisioningAuthenticationTag(wrongProcessSigner, request, peerIdentity, credentials),
    ).toThrow("credential provisioning denied");
    wrongProcessSigner.dispose();
  });
});
describe("revision-9 worker credential provisioning", () => {
  test("accepts one authenticated envelope bound to the exact minimal provider set", () => {
    const { receiver } = setup();
    const accepted = receiver.provision(frame());

    expect(accepted).toMatchObject({
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 7,
      principalId: "principal-1",
      nonceRef: digest,
      acceptedCredentialDigests: [credentialRef.credentialDigest],
    });
  });

  test.each([
    ["peer", frame({ peerIdentity: { ...peerIdentity, workerId: "worker-2" } })],
    ["principal", frame({ request: { ...request, principalId: "principal-2" } })],
    ["worker", frame({ request: { ...request, workerId: "worker-2" } })],
    ["generation", frame({ request: { ...request, generation: 8 } })],
    ["stale Attempt", frame({ request: { ...request, attempt: { ...attempt, attemptSeq: 2 } } })],
    ["process", frame({ peerIdentity: { ...peerIdentity, processId: process.pid + 1 } })],
    [
      "provider",
      frame({
        request: {
          ...request,
          providerIds: ["anthropic"],
          credentialRefs: [{ ...credentialRef, providerId: "anthropic" }],
        },
      }),
    ],
    ["nonce", frame({ request: { ...request, nonceRef: "c".repeat(64) } })],
  ])("denies a correctly authenticated envelope with wrong %s binding", (_name, input) => {
    expectDenied(input);
  });

  test("denies non-closed peer and envelope shapes and scrubs credential custody", () => {
    const extraPeer = frame({
      peerIdentity: { ...peerIdentity, unexpected: "value" } as P2ProvisioningPeerIdentity,
    });
    const extraEnvelope = {
      ...frame(),
      unexpected: "value",
    } as P2CredentialProvisioningFrame;

    for (const input of [extraPeer, extraEnvelope]) {
      const { receiver } = setup();
      expect(() => receiver.provision(input)).toThrow("credential provisioning denied");
      expect(allZero(input.authenticationTag)).toBe(true);
      expect(allZero(credentialSecret(input))).toBe(true);
    }
  });

  test.each([
    ["stale credential digest", { ...credentialRef, credentialDigest: otherDigest }],
    ["malformed source-path digest", { ...credentialRef, sourcePathDigest: "c".repeat(64) }],
  ])("denies an authenticated %s expected ref and terminally cleans up", (_name, expectedRef) => {
    const expectedRequest = { ...request, credentialRefs: [expectedRef] };
    const input = frame({ request: expectedRequest });
    const { receiver, key, disposeCalls } = setup({ credentialRefs: [expectedRef] });

    const error = deniedError(receiver, input);
    expect((error.cause as { code?: string }).code).toBe("CREDENTIAL_BINDING_MISMATCH");
    expect(allZero(key)).toBe(true);
    expect(allZero(input.authenticationTag)).toBe(true);
    expect(allZero(credentialSecret(input))).toBe(true);
    expect(disposeCalls()).toBe(1);
    expect(() => receiver.sanitizer.sanitizeText("test", canary)).toThrow("disposed");
  });

  test("denies wrong MAC and expiry at or before database time", () => {
    expectDenied(frame({ authenticationTag: new Uint8Array(32) }));
    expectDenied(frame(), { nowDbMs: () => 100 });
  });

  test("uses one database-time sample for expiry and receipt acceptance", () => {
    let clockCalls = 0;
    const { receiver } = setup({
      nowDbMs: () => {
        clockCalls += 1;
        return clockCalls === 1 ? 99 : 101;
      },
    });

    const accepted = receiver.provision(frame());
    expect(accepted.acceptedAtDbMs).toBe(99);
    expect(accepted.acceptedAtDbMs).toBeLessThan(request.expiresAt);
    expect(clockCalls).toBe(1);
  });

  test("binds binary secrets, proxy URL, optional-secret presence, credential count, and order", () => {
    const proxyRef = canonicalCredentialRef({
      providerId: "anthropic",
      credentialId: "anthropic-default",
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: {
        type: "proxy",
        baseURL: "https://proxy.invalid/v1",
        apiKey: "canonical-proxy-secret",
      },
    });
    const twoProviderRequest = {
      ...request,
      providerIds: ["openai", "anthropic"],
      credentialRefs: [credentialRef, proxyRef],
    };
    const matchingBinding = {
      providerIds: twoProviderRequest.providerIds,
      credentialRefs: twoProviderRequest.credentialRefs,
    };
    const makeInput = () =>
      frame({
        request: twoProviderRequest,
        credentials: [
          {
            providerId: "openai",
            credentialId: "owner-default",
            authType: "api",
            secret: new Uint8Array([0, 255, 1, 128]),
          },
          {
            providerId: "anthropic",
            credentialId: "anthropic-default",
            authType: "proxy",
            baseURL: "https://proxy.invalid/v1",
            secret: new Uint8Array([9, 0, 8]),
          },
        ],
      });

    const secretTamper = makeInput();
    credentialSecret(secretTamper)[1] = 254;
    expectDenied(secretTamper, matchingBinding);

    const urlTamper = makeInput();
    (urlTamper.credentials[1] as { baseURL: string }).baseURL = "https://other.invalid/v1";
    expectDenied(urlTamper, matchingBinding);

    const optionalSecretTamper = makeInput();
    delete (optionalSecretTamper.credentials[1] as { secret?: Uint8Array }).secret;
    expectDenied(optionalSecretTamper, matchingBinding);

    const orderTamper = makeInput();
    (orderTamper.credentials as unknown as unknown[]).reverse();
    expectDenied(orderTamper, matchingBinding);

    const countTamper = makeInput();
    (countTamper.credentials as unknown as unknown[]).pop();
    expectDenied(countTamper, matchingBinding);

    const truncationTamper = makeInput();
    const truncated = credentialSecret(truncationTamper).slice(0, 3);
    (truncationTamper.credentials[0] as { secret: Uint8Array }).secret = truncated;
    expectDenied(truncationTamper, matchingBinding);
  });

  test("denies missing, extra, and duplicate provider material", () => {
    expectDenied(frame({ credentials: [] }));
    const material = required(frame().credentials[0], "credential material is missing");
    expectDenied(frame({ credentials: [material, material] }));
    expectDenied(
      frame({
        credentials: [
          material,
          { ...material, providerId: "anthropic", secret: p2ProvisioningBytes("other") },
        ],
      }),
    );
  });

  test("denies replay when racing receivers consume the same Attempt nonce", () => {
    const consumed = new Set<string>();
    const nonces = nonceStore(consumed);
    setup({ nonces }).receiver.provision(frame());
    expectDenied(frame(), { nonces });
  });

  test("materializes only the accepted provider and scrubs its copy", async () => {
    const { receiver } = setup();
    receiver.provision(frame());
    let exposed: Uint8Array | undefined;

    const result = await receiver.withProviderCredential("openai", (credential) => {
      if (credential.authType !== "api") throw new Error("unexpected auth type");
      exposed = credential.key;
      return new TextDecoder().decode(credential.key);
    });

    expect(result).toBe(canary);
    expect(allZero(required(exposed, "credential callback was not invoked"))).toBe(true);
    await expect(
      receiver.withProviderCredential("anthropic", async () => undefined),
    ).rejects.toThrow("credential provisioning denied");
  });

  test("scrubs private-FD key, MAC, and credential frame buffers on success and failure", () => {
    for (const [index, input] of [
      frame(),
      frame({ authenticationTag: new Uint8Array(32) }),
    ].entries()) {
      const { receiver, key, disposeCalls } = setup();
      if (index === 0) expect(() => receiver.provision(input)).not.toThrow();
      else expect(() => receiver.provision(input)).toThrow("credential provisioning denied");
      expect(allZero(key)).toBe(true);
      expect(allZero(input.authenticationTag)).toBe(true);
      expect(allZero(credentialSecret(input))).toBe(true);
      expect(disposeCalls()).toBe(1);
    }
  });

  test("acknowledges one exact secret-free receipt only after registration and buffer scrubbing", async () => {
    const { receiver, key } = setup();
    const input = frame();
    const privateFrame = new Uint8Array(32);
    const receipt = {
      version: "credential-provisioning-receipt-v1" as const,
      runtimeId: request.runtimeId,
      workerId: request.workerId,
      generation: request.generation,
      principalId: request.principalId,
      attempt,
      nonceRef: request.nonceRef,
      acceptedCredentialDigests: [credentialRef.credentialDigest],
      acceptedAtDbMs: 50,
    };
    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];

    await WorkerRunner.acknowledgeCredentialProvisioning({
      provisioner: receiver,
      frame: input,
      receipt,
      scrubbedBuffers: [privateFrame, key, input.authenticationTag, credentialSecret(input)],
      server: {
        async call(method, params) {
          expect(allZero(key)).toBe(true);
          expect(allZero(input.authenticationTag)).toBe(true);
          expect(allZero(credentialSecret(input))).toBe(true);
          calls.push({ method, params });
          return { accepted: true };
        },
      },
      workerId: request.workerId,
      generation: request.generation,
      processId: process.pid,
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(calls).toEqual([
      {
        method: "worker.credential_provision_ack",
        params: {
          workerId: request.workerId,
          generation: request.generation,
          processId: process.pid,
          runId: "run-1",
          sessionId: "session-1",
          receipt,
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(canary);
  });

  test("does not retry or proceed when the durable acknowledgement is missing or rejected", async () => {
    for (const failure of [
      new Error("socket closed"),
      new Error("credential provisioning denied"),
      { accepted: false },
    ]) {
      const { receiver, key } = setup();
      const input = frame();
      let calls = 0;
      await expect(
        WorkerRunner.acknowledgeCredentialProvisioning({
          provisioner: receiver,
          frame: input,
          receipt: {
            version: "credential-provisioning-receipt-v1",
            runtimeId: request.runtimeId,
            workerId: request.workerId,
            generation: request.generation,
            principalId: request.principalId,
            attempt,
            nonceRef: request.nonceRef,
            acceptedCredentialDigests: [credentialRef.credentialDigest],
            acceptedAtDbMs: 50,
          },
          scrubbedBuffers: [key, input.authenticationTag, credentialSecret(input)],
          server: {
            async call() {
              calls += 1;
              if (failure instanceof Error) throw failure;
              return failure;
            },
          },
          workerId: request.workerId,
          generation: request.generation,
          processId: process.pid,
          runId: "run-1",
          sessionId: "session-1",
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  test("validates a complete runtime frame before safe failure cleanup", () => {
    const { receiver, key, disposeCalls } = setup();
    const authenticationTag = new Uint8Array(32).fill(7);
    const malformed = {
      request,
      peerIdentity,
      authenticationTag,
      credentials: [null],
    } as unknown as P2CredentialProvisioningFrame;

    const error = deniedError(receiver, malformed);
    expect(error.message).toBe("credential provisioning denied");
    expect((error.cause as { code?: string }).code).toBe("FRAME_INVALID");
    expect(allZero(authenticationTag)).toBe(true);
    expect(allZero(key)).toBe(true);
    expect(disposeCalls()).toBe(1);
    expect(() => receiver.sanitizer.sanitizeText("test", canary)).toThrow("disposed");
  });

  test("denies accessor-bearing requests without executing accessors and terminally scrubs custody", () => {
    let accessorCalls = 0;
    const valid = frame();
    const accessorRequest = { ...request };
    Object.defineProperty(accessorRequest, "attempt", {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        throw new Error(canary);
      },
    });
    const input = { ...valid, request: accessorRequest } as P2CredentialProvisioningFrame;
    const { receiver, key, disposeCalls } = setup();

    const error = deniedError(receiver, input);
    expect((error.cause as { code?: string }).code).toBe("FRAME_INVALID");
    expect(accessorCalls).toBe(0);
    expect(allZero(key)).toBe(true);
    expect(allZero(input.authenticationTag)).toBe(true);
    expect(allZero(credentialSecret(input))).toBe(true);
    expect(disposeCalls()).toBe(1);
    expect(() => receiver.sanitizer.sanitizeText("test", canary)).toThrow("disposed");
    expect(() => receiver.provision(frame())).toThrow("credential provisioning denied");
  });

  test("denies proxied requests without executing proxy traps before terminal cleanup", () => {
    let proxyCalls = 0;
    const valid = frame();
    const input = {
      ...valid,
      request: new Proxy(request, {
        get: () => {
          proxyCalls += 1;
          throw new Error(canary);
        },
        getOwnPropertyDescriptor: () => {
          proxyCalls += 1;
          throw new Error(canary);
        },
        ownKeys: () => {
          proxyCalls += 1;
          throw new Error(canary);
        },
      }),
    } as P2CredentialProvisioningFrame;
    const { receiver, key, disposeCalls } = setup();

    const error = deniedError(receiver, input);
    expect((error.cause as { code?: string }).code).toBe("FRAME_INVALID");
    expect(proxyCalls).toBe(0);
    expect(allZero(key)).toBe(true);
    expect(allZero(input.authenticationTag)).toBe(true);
    expect(allZero(credentialSecret(input))).toBe(true);
    expect(disposeCalls()).toBe(1);
  });

  test("partial registration failure disposes retained registry and sanitizer material", () => {
    const anthropicRef = canonicalCredentialRef({
      providerId: "anthropic",
      credentialId: "anthropic-default",
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: "canonical-anthropic-secret" },
    });
    const twoProviderRequest = {
      ...request,
      providerIds: ["openai", "anthropic"],
      credentialRefs: [credentialRef, anthropicRef],
    };
    const firstSecret = p2ProvisioningBytes(canary);
    const secondSecret = new Uint8Array(0);
    const input = frame({
      request: twoProviderRequest,
      credentials: [
        {
          providerId: "openai",
          credentialId: "owner-default",
          authType: "api",
          secret: firstSecret,
        },
        {
          providerId: "anthropic",
          credentialId: "anthropic-default",
          authType: "api",
          secret: secondSecret,
        },
      ],
    });
    const { receiver, key, disposeCalls } = setup({
      providerIds: twoProviderRequest.providerIds,
      credentialRefs: twoProviderRequest.credentialRefs,
    });

    const error = deniedError(receiver, input);
    expect((error.cause as { code?: string }).code).toBe("MATERIAL_REGISTRATION_FAILED");
    expect(allZero(firstSecret)).toBe(true);
    expect(allZero(secondSecret)).toBe(true);
    expect(() => receiver.sanitizer.sanitizeText("test", canary)).toThrow("disposed");
    expect(allZero(key)).toBe(true);
    expect(disposeCalls()).toBe(1);
    receiver.dispose();
    receiver.dispose();
    expect(disposeCalls()).toBe(1);
    expect(() => receiver.provision(frame())).toThrow("credential provisioning denied");
  });

  test("cleanup failure does not mask the primary provisioning classification", () => {
    const key = p2ProvisioningBytes(keyText);
    const { receiver } = setup({
      keyMaterial: {
        take: () => key,
        dispose: () => {
          throw new Error("cleanup exploded");
        },
      },
    });
    const input = frame({ authenticationTag: new Uint8Array(32) });

    const error = deniedError(receiver, input);
    expect(error.message).toBe("credential provisioning denied");
    expect(error.message).not.toContain("cleanup exploded");
    const cause = error.cause as { code?: string; cleanupFailure?: { code?: string } };
    expect(cause.code).toBe("AUTHENTICATION_FAILED");
    expect(cause.cleanupFailure?.code).toBe("CLEANUP_FAILED");
    expect(allZero(key)).toBe(true);
    expect(allZero(input.authenticationTag)).toBe(true);
    expect(allZero(credentialSecret(input))).toBe(true);
  });

  test("dispose before or after provisioning scrubs all resources and is idempotent", async () => {
    for (const provisioned of [false, true]) {
      const { receiver, key, disposeCalls } = setup();
      if (provisioned) {
        receiver.provision(frame());
        expect(receiver.sanitizer.sanitizeText("test", canary)).toBe("[REDACTED]");
      }

      receiver.dispose();
      receiver.dispose();

      expect(allZero(key)).toBe(true);
      expect(disposeCalls()).toBe(1);
      expect(() => receiver.sanitizer.sanitizeText("test", canary)).toThrow("disposed");
      await expect(
        receiver.withProviderCredential("openai", async () => undefined),
      ).rejects.toThrow("credential provisioning denied");
      expect(() => receiver.provision(frame())).toThrow("credential provisioning denied");
    }
  });

  test("explicit dispose reports the first sanitized cleanup failure after attempting all cleanup", () => {
    const key = p2ProvisioningBytes(keyText);
    let disposeCalls = 0;
    const receiver = createP2WorkerCredentialProvisioner({
      ...peerIdentity,
      attempt,
      nonceRef: request.nonceRef,
      providerIds: request.providerIds,
      credentialRefs: request.credentialRefs,
      keyMaterial: {
        take: () => key,
        dispose: () => {
          disposeCalls += 1;
          throw new Error(`cleanup exploded ${canary}`);
        },
      },
      nonces: nonceStore(),
      nowDbMs: () => 50,
    });

    let first: unknown;
    try {
      receiver.dispose();
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(P2ProvisioningCleanupError);
    expect((first as P2ProvisioningCleanupError).code).toBe(
      "CREDENTIAL_PROVISIONING_CLEANUP_FAILED",
    );
    expect((first as Error).message).not.toContain(canary);
    expect(((first as Error).cause as { code?: string }).code).toBe("CLEANUP_FAILED");
    expect(allZero(key)).toBe(true);
    expect(disposeCalls).toBe(1);
    expect(() => receiver.sanitizer.sanitizeText("test", canary)).toThrow("disposed");
    expect(() => receiver.dispose()).not.toThrow();
    expect(disposeCalls).toBe(1);
  });

  test("redacts frame diagnostics and sanitizes provider errors", async () => {
    const { receiver } = setup();
    const input = frame();
    const metadata = JSON.stringify(describeP2ProvisioningFrame(input));
    expect(metadata).not.toContain(keyText);
    expect(metadata).not.toContain(canary);
    expect(metadata).not.toContain("baseURL");
    receiver.provision(input);

    await expect(
      receiver.withProviderCredential("openai", async (credential) => {
        if (credential.authType !== "api") throw new Error("unexpected auth type");
        throw new Error(`provider rejected ${new TextDecoder().decode(credential.key)}`);
      }),
    ).rejects.toThrow("[REDACTED]");
  });

  test("diagnostics never invoke accessors and return stable inert invalid placeholders", () => {
    let executions = 0;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "request", {
      enumerable: true,
      get: () => {
        executions += 1;
        throw new Error(canary);
      },
    });
    Object.defineProperties(hostile, {
      peerIdentity: {
        value: new Proxy(peerIdentity, {
          get: () => {
            executions += 1;
            throw new Error(canary);
          },
        }),
      },
      authenticationTag: { value: new Uint8Array(32) },
      credentials: {
        value: [
          Object.defineProperty({}, "providerId", {
            get: () => {
              executions += 1;
              throw new Error(canary);
            },
          }),
        ],
      },
    });

    const first = describeP2ProvisioningFrame(hostile as unknown as P2CredentialProvisioningFrame);
    const second = describeP2ProvisioningFrame(hostile as unknown as P2CredentialProvisioningFrame);
    expect(executions).toBe(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain(canary);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
  });

  test("diagnostics are detached from every returned nested record and array", () => {
    const mutableRequest = {
      ...request,
      attempt: { ...attempt },
      providerIds: [...request.providerIds],
      credentialRefs: [{ ...credentialRef }],
    };
    const mutablePeer = { ...peerIdentity };
    const input = frame({ request: mutableRequest, peerIdentity: mutablePeer });
    const description = describeP2ProvisioningFrame(input);

    mutableRequest.runtimeId = "mutated-runtime";
    mutableRequest.attempt.attemptId = "mutated-attempt";
    mutableRequest.providerIds[0] = "mutated-provider";
    required(mutableRequest.credentialRefs[0], "credential reference is missing").credentialId =
      "mutated-credential";
    mutablePeer.workerId = "mutated-worker";
    (input.credentials[0] as { providerId: string }).providerId = "mutated-material";

    const serialized = JSON.stringify(description);
    expect(serialized).toContain("runtime-1");
    expect(serialized).toContain("attempt-1");
    expect(serialized).toContain("owner-default");
    expect(serialized).not.toContain("mutated-");
    const diagnosticRequest = description.request as Record<string, unknown>;
    expect(Object.getPrototypeOf(diagnosticRequest)).toBeNull();
    expect(Object.isFrozen(diagnosticRequest.providerIds)).toBe(true);
    expect(Object.isFrozen(diagnosticRequest.credentialRefs)).toBe(true);
  });
  test("scrubs every later terminal frame and survives a pre-disposed sanitizer", () => {
    const first = setup();
    first.receiver.provision(frame());
    const secondInput = frame();
    expect(() => first.receiver.provision(secondInput)).toThrow("credential provisioning denied");
    expect(allZero(secondInput.authenticationTag)).toBe(true);
    expect(allZero(credentialSecret(secondInput))).toBe(true);

    const disposed = setup();
    disposed.receiver.sanitizer.dispose();
    const disposedInput = frame();
    expect(() => disposed.receiver.provision(disposedInput)).toThrow(
      "credential provisioning denied",
    );
    expect(allZero(disposed.key)).toBe(true);
    expect(disposed.disposeCalls()).toBe(1);
    expect(allZero(disposedInput.authenticationTag)).toBe(true);
    expect(allZero(credentialSecret(disposedInput))).toBe(true);
  });

  test("bounds oversized sparse provisioning and diagnostics while scrubbing present buffers", () => {
    const material = {
      providerId: "openai",
      credentialId: "owner-default",
      authType: "api" as const,
      secret: p2ProvisioningBytes(canary),
    };
    const sparse: ProvisionedCredentialMaterial[] = [];
    sparse.length = 1_000_000;
    sparse[999_999] = material;
    const valid = frame();
    credentialSecret(valid).fill(0);
    const input = {
      ...valid,
      credentials: sparse,
    } as P2CredentialProvisioningFrame;
    const { receiver } = setup();

    expect(() => receiver.provision(input)).toThrow("credential provisioning denied");
    expect(allZero(input.authenticationTag)).toBe(true);
    expect(allZero(material.secret)).toBe(true);
    expect(JSON.stringify(describeP2ProvisioningFrame(input))).toContain(
      "invalid-credential-material",
    );
  });

  test("scrubs every credential buffer in a dense oversized frame", () => {
    const dense = Array.from({ length: 300 }, (_, index) => ({
      providerId: `provider-${index}`,
      credentialId: `credential-${index}`,
      authType: "api" as const,
      secret: p2ProvisioningBytes(`dense-secret-${index}`),
    }));
    const valid = frame();
    credentialSecret(valid).fill(0);
    const input = {
      ...valid,
      credentials: dense,
    } as P2CredentialProvisioningFrame;
    const { receiver } = setup();

    expect(() => receiver.provision(input)).toThrow("credential provisioning denied");
    expect(allZero(input.authenticationTag)).toBe(true);
    expect(dense.every((material) => allZero(material.secret))).toBe(true);
  });

  test("zeroes materialized callback buffers after both success and rejection", async () => {
    const { receiver } = setup();
    receiver.provision(frame());
    let successful: Uint8Array | undefined;
    await receiver.withProviderCredential("openai", (credential) => {
      if (credential.authType !== "api") throw new Error("unexpected auth type");
      successful = credential.key;
    });
    expect(allZero(required(successful, "successful credential callback was not invoked"))).toBe(
      true,
    );

    let rejected: Uint8Array | undefined;
    await expect(
      receiver.withProviderCredential("openai", (credential) => {
        if (credential.authType !== "api") throw new Error("unexpected auth type");
        rejected = credential.key;
        throw new Error(`rejected ${new TextDecoder().decode(credential.key)}`);
      }),
    ).rejects.toThrow("[REDACTED]");
    expect(allZero(required(rejected, "rejected credential callback was not invoked"))).toBe(true);
  });
});

describe("provisioned worker model catalog", () => {
  test("pins the authenticated provider and model without ambient catalog authority", async () => {
    const environment = {
      version: "llm-environment-v1" as const,
      catalogSchemaVersion: 1,
      catalogSource: "bundled" as const,
      catalogSourceVersion: "pinned-test",
      catalogDigest: digest,
      modelDigest: otherDigest,
      endpoint: {
        version: "llm-endpoint-ref-v1" as const,
        kind: "default" as const,
        valueRef: "openai:default",
        endpointDigest: digest,
      },
      credential: credentialRef,
      sdkPackage: "@ai-sdk/openai",
      adapterVersion: "1",
      environmentDigest: digest,
    };
    const catalog = createPinnedWorkerModelCatalog({
      model: { provider: "openai", id: "gpt-pinned" },
      environment,
    });

    const loaded = await catalog.load();
    expect(loaded.environment).toBe(environment);
    expect(Object.keys(await catalog.get())).toEqual(["openai"]);
    const models = await Provider.listModels(catalog, "openai");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      providerID: "openai",
      id: "gpt-pinned",
      api: { id: "gpt-pinned", npm: "@ai-sdk/openai" },
    });
    await expect(Provider.listModels(catalog, "anthropic")).rejects.toThrow(
      "Unknown provider: anthropic",
    );
  });
});

describe("worker transfer credential references", () => {
  test("rebinds file-backed Owner custody to a generation-scoped injected ref", () => {
    const ownerRef = canonicalCredentialRef({
      providerId: "openai",
      credentialId: "owner-default",
      rotationId: "owner-rotation",
      sourceKind: "default_file",
      sourcePath: "/owner/private/auth.json",
      auth: { type: "api", key: canary },
    });
    const first = createP2WorkerTransferCredentialRef({
      ownerRef,
      peerIdentity,
      attempt,
      credential: {
        providerId: "openai",
        authType: "api",
        key: p2ProvisioningBytes(canary),
      },
    });
    const second = createP2WorkerTransferCredentialRef({
      ownerRef,
      peerIdentity,
      attempt,
      credential: {
        providerId: "openai",
        authType: "api",
        key: p2ProvisioningBytes(canary),
      },
    });

    expect(first).toEqual(second);
    expect(first.sourceKind).toBe("injected_runtime");
    expect(first.sourcePathDigest).not.toBe(ownerRef.sourcePathDigest);
    expect(first.rotationId).not.toBe(ownerRef.rotationId);
    expect(first.credentialDigest).not.toBe(ownerRef.credentialDigest);
    expect(JSON.stringify(first)).not.toContain("/owner/private/auth.json");
    expect(JSON.stringify(first)).not.toContain(canary);

    const substitutedPid = createP2WorkerTransferCredentialRef({
      ownerRef,
      peerIdentity: { ...peerIdentity, processId: process.pid + 1 },
      attempt,
      credential: {
        providerId: "openai",
        authType: "api",
        key: p2ProvisioningBytes(canary),
      },
    });
    expect(substitutedPid).not.toEqual(first);
    expect(JSON.stringify(substitutedPid)).not.toContain(canary);
  });
});

describe("authenticated worker process activation", () => {
  const model = { provider: "openai", id: "gpt-pinned" };
  const systemPrompt = "authenticated worker prompt";
  const permissions = { action: "tool.call" as const, allowlist: ["read", "dispatch"] };
  const policyPlan = {
    policies: [{ id: "builtin:tool-permission", required: true }],
    labels: ["authenticated-worker"],
  };

  function activation(
    overrides: { readonly requestAgent?: string; readonly returnedAttempt?: typeof attempt } = {},
  ) {
    const workspaceIdentity = createWorkspaceIdentity(process.cwd());
    const sanitizer = BoundarySanitizer.create();
    const secrets = SecretRegistry.create(sanitizer);
    const environmentCredential = secrets.register(
      CredentialSource.parseOwner({
        providerId: "openai",
        credentialId: "owner-default",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: { type: "api", key: canary },
      }),
    );
    let environmentDisposed = false;
    const disposeEnvironment = () => {
      if (environmentDisposed) return;
      environmentDisposed = true;
      secrets.dispose();
    };
    const environmentRef = {
      version: "llm-environment-v1" as const,
      catalogSchemaVersion: 1,
      catalogSource: "bundled" as const,
      catalogSourceVersion: "worker-test",
      catalogDigest: digest,
      modelDigest: otherDigest,
      endpoint: {
        version: "llm-endpoint-ref-v1" as const,
        kind: "default" as const,
        valueRef: "openai:default",
        endpointDigest: digest,
      },
      credential: environmentCredential.ref,
      sdkPackage: "@ai-sdk/openai",
      adapterVersion: "1",
      environmentDigest: digest,
    };
    const agent = {
      name: "authenticated-agent",
      description: "worker",
      model,
      systemPrompt,
      tools: { allow: ["read", "dispatch"] },
      permissions,
      policyPlan,
      budget: { maxTurns: 2 },
    };
    const runtime = {
      runtimeId: "runtime-1",
      workerId: "worker-1",
      generation: 7,
      principalId: "principal-1",
      attempt,
      config: {
        configEpoch: "epoch-1",
        model,
        environment: environmentRef,
        workspace: toWorkspaceRef(workspaceIdentity),
        agents: [agent],
        toolCatalog: [
          {
            canonicalName: "read",
            exposedName: "read",
            source: "server" as const,
            category: "filesystem" as const,
            riskTier: 0 as const,
            spec: { name: "read", inputSchema: { type: "object" } },
          },
          {
            canonicalName: "dispatch",
            exposedName: "dispatch",
            source: "agent" as const,
            category: "delegation" as const,
            riskTier: 1 as const,
            spec: { name: "dispatch", inputSchema: { type: "object" } },
          },
        ],
      },
    };
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedMessages: unknown;
    const queryKinds: string[] = [];
    let resolveResponse!: (value: unknown) => void;
    const response = new Promise<unknown>((resolve) => {
      resolveResponse = resolve;
    });
    void response.finally(disposeEnvironment);
    WorkerRunner.spawnRun({
      params: {
        authToken: "token",
        runId: "run-1",
        sessionId: "session-1",
        mode: "direct",
        prompt: "current prompt",
        model,
        systemPrompt,
        permissions,
        policyPlan,
        agentName: overrides.requestAgent ?? agent.name,
        budget: agent.budget,
      },
      respond: resolveResponse,
      ipcAuthToken: "token",
      workerId: "worker-1",
      server: {
        async call(method, params) {
          if (method !== "worker.kernel_query") throw new Error(`unexpected call: ${method}`);
          const query = params?.request as { kind?: string } | undefined;
          queryKinds.push(query?.kind ?? "missing");
          if (query?.kind === "authenticated_attempt") {
            return {
              version: "kernel-query-result-v1",
              kind: "authenticated_attempt",
              attempt: overrides.returnedAttempt ?? attempt,
              events: [],
            };
          }
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_transcript",
            messages: [{ role: "user", content: "prior-message" }],
          };
        },
        notify() {
          return undefined;
        },
      },
      activeRuns: new Map(),
      injectionQueue: InjectionQueue.create(),
      onSettled: disposeEnvironment,
      runtime,
      workspaceIdentity,
      environment: {
        reference: environmentRef,
        credential: environmentCredential.handle,
        secrets,
        sanitizer,
      },
      modelCatalog: createPinnedWorkerModelCatalog({ model, environment: environmentRef }),
      createAgentToolProvider: (options) =>
        new AgentToolProvider(options as ConstructorParameters<typeof AgentToolProvider>[0]),
      createAgent: (options) => {
        capturedOptions = options as unknown as Record<string, unknown>;
        return {
          async run(input) {
            capturedMessages = input.messages;
            return {
              text: "done",
              steps: [],
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              finishReason: "stop" as const,
            };
          },
        };
      },
    });
    return {
      response,
      environmentRef,
      get capturedOptions() {
        return capturedOptions;
      },
      get capturedMessages() {
        return capturedMessages;
      },
      queryKinds,
    };
  }

  test("carries only authenticated agent policy, catalog, environment, and transcript into a run", async () => {
    const run = activation();
    expect(await run.response).toMatchObject({ status: "succeeded", output: "done" });
    expect(run.queryKinds).toEqual(["authenticated_attempt", "authenticated_transcript"]);
    expect(run.capturedOptions?.systemPrompt).toBe(systemPrompt);
    expect(run.capturedOptions?.environment).toMatchObject({ reference: run.environmentRef });
    expect(
      (run.capturedOptions?.tools as Array<{ name: string }>).map((tool) => tool.name).sort(),
    ).toEqual(["dispatch", "read"]);
    expect(JSON.stringify(run.capturedOptions?.middleware)).toContain("tool-permission");
    expect(JSON.stringify(run.capturedMessages)).toContain("prior-message");
    expect(JSON.stringify(run.capturedMessages)).toContain("current prompt");
  });

  test("rejects mismatched authenticated agent and attempt facts", async () => {
    expect(await activation({ requestAgent: "other-agent" }).response).toMatchObject({
      status: "failed",
      error: "run agent does not match the authenticated runtime",
    });
    expect(
      await activation({ returnedAttempt: { ...attempt, attemptId: "other-attempt" } }).response,
    ).toMatchObject({
      status: "failed",
      error: "run attempt does not match the authenticated runtime",
    });
  });
});
