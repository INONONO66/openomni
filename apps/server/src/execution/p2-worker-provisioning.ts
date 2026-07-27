import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, readSync } from "node:fs";
import { isProxy } from "node:util/types";
import { Execution } from "@openomni/protocol";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
  type MaterializedCredential,
  type SecretHandle,
} from "@openomni/llm/credential-runtime";

export type ProvisionedCredentialMaterial =
  | {
      readonly providerId: string;
      readonly credentialId: string;
      readonly authType: "api";
      readonly secret: Uint8Array;
    }
  | {
      readonly providerId: string;
      readonly credentialId: string;
      readonly authType: "proxy";
      readonly baseURL: string;
      readonly secret?: Uint8Array;
    };

export interface P2ProvisioningPeerIdentity {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly processId: number;
}

export interface P2CredentialProvisioningFrame {
  readonly request: unknown;
  readonly peerIdentity: P2ProvisioningPeerIdentity;
  /** Mutable HMAC-SHA256 tag received with the private provisioning frame. */
  readonly authenticationTag: Uint8Array;
  readonly credentials: readonly ProvisionedCredentialMaterial[];
}

export interface P2PrivateProvisioningFrame {
  readonly peerIdentity: P2ProvisioningPeerIdentity;
  readonly authenticationTag: Uint8Array;
  readonly credentials: readonly ProvisionedCredentialMaterial[];
}

export interface P2ProvisioningAuthenticationSigner {
  readonly context: P2ProvisioningPeerIdentity & {
    readonly attempt: Execution.CredentialProvisioningRequestV1["attempt"];
  };
  sign(bytes: Uint8Array): Uint8Array;
}

/** Worker-local key bytes received through an injected private-FD reader. */
export interface P2PrivateFdKeyMaterial {
  take(): Uint8Array;
  dispose(): void;
}

export interface P2ProvisioningNonceStore {
  /** Atomically consumes a nonce, returning false when it was already consumed. */
  consume(nonceRef: string): boolean;
}

export interface P2ProvisioningBinding extends Omit<P2ProvisioningPeerIdentity, "processId"> {
  readonly processId?: number;
  readonly attempt: Execution.CredentialProvisioningRequestV1["attempt"];
  readonly nonceRef: string;
  readonly providerIds: readonly string[];
  readonly credentialRefs: readonly Execution.CredentialSourceRefV1[];
  readonly keyMaterial: P2PrivateFdKeyMaterial;
  readonly nonces: P2ProvisioningNonceStore;
  readonly nowDbMs: () => number;
}

export class P2ProvisioningDeniedError extends Error {
  readonly code = "CREDENTIAL_PROVISIONING_DENIED";

  constructor(internalFailure?: Error) {
    super("credential provisioning denied", {
      ...(internalFailure === undefined ? {} : { cause: internalFailure }),
    });
    this.name = "P2ProvisioningDeniedError";
  }
}

class P2ProvisioningInternalFailure extends Error {
  readonly code: string;
  readonly cleanupFailure?: Error;

  constructor(code: string, cause?: unknown, cleanupFailure?: Error) {
    super(code, { ...(cause === undefined ? {} : { cause }) });
    this.name = "P2ProvisioningInternalFailure";
    this.code = code;
    if (cleanupFailure !== undefined) this.cleanupFailure = cleanupFailure;
  }
}

export class P2ProvisioningCleanupError extends Error {
  readonly code = "CREDENTIAL_PROVISIONING_CLEANUP_FAILED";

  constructor(internalFailure: Error) {
    super("worker credential cleanup failed", { cause: internalFailure });
    this.name = "P2ProvisioningCleanupError";
  }
}

export interface P2WorkerCredentialProvisioner {
  readonly sanitizer: BoundarySanitizer;
  readonly registry: SecretRegistry;
  credentialHandle(providerId: string): SecretHandle;
  provision(frame: P2CredentialProvisioningFrame): Execution.CredentialProvisioningReceiptV1;
  withProviderCredential<T>(
    providerId: string,
    use: (credential: MaterializedCredential) => T | Promise<T>,
  ): Promise<T>;
  dispose(): void;
}

/** Derives the generation/attempt-scoped public ref used for a worker transfer. */
export function createP2WorkerTransferCredentialRef(options: {
  readonly ownerRef: Execution.CredentialSourceRefV1;
  readonly peerIdentity: P2ProvisioningPeerIdentity;
  readonly attempt: Execution.CredentialProvisioningRequestV1["attempt"];
  readonly credential: MaterializedCredential;
}): Execution.CredentialSourceRefV1 {
  const rotationId = `worker-transfer-${createHash("sha256")
    .update(
      JSON.stringify({
        ownerRotationId: options.ownerRef.rotationId,
        peerIdentity: options.peerIdentity,
        attempt: options.attempt,
      }),
    )
    .digest("hex")}`;
  const sanitizer = BoundarySanitizer.create();
  const registry = SecretRegistry.create(sanitizer);
  try {
    const credential = options.credential;
    const source = CredentialSource.parseOwner({
      providerId: options.ownerRef.providerId,
      credentialId: options.ownerRef.credentialId,
      rotationId,
      ...(options.ownerRef.account === undefined ? {} : { account: options.ownerRef.account }),
      sourceKind: "injected_runtime",
      ...(options.ownerRef.endpointRef === undefined
        ? {}
        : { endpointRef: options.ownerRef.endpointRef }),
      auth:
        credential.authType === "api"
          ? { type: "api", key: credential.key.slice() }
          : {
              type: "proxy",
              baseURL: credential.baseURL,
              ...(credential.apiKey === undefined ? {} : { apiKey: credential.apiKey.slice() }),
            },
    });
    return registry.register(source).ref;
  } finally {
    registry.dispose();
  }
}

const encoder = new TextEncoder();
const HMAC_BYTES = 32;
const MAX_PROVISIONING_ITEMS = 256;
export const P2_GENERATION_KEY_BYTES = 32;
export const P2_PRIVATE_PROVISIONING_FRAME_MAX_BYTES = 1024 * 1024;
const MAX_PRIVATE_FIELD_BYTES = 256 * 1024;
const PRIVATE_FRAME_MAGIC = new Uint8Array([0x4f, 0x4d, 0x50, 0x32, 0x02]);
const decoder = new TextDecoder("utf-8", { fatal: true });

export function readP2PrivateFdKeyMaterial(fd: number): P2PrivateFdKeyMaterial {
  if (!Number.isSafeInteger(fd) || fd < 0) {
    throw new TypeError("invalid private generation-key descriptor");
  }
  const key = new Uint8Array(P2_GENERATION_KEY_BYTES);
  let offset = 0;
  try {
    while (offset < key.byteLength) {
      const count = readSync(fd, key, offset, key.byteLength - offset, null);
      if (count === 0) throw new Error("invalid private generation key");
      offset += count;
    }
  } catch (error) {
    key.fill(0);
    throw error;
  }

  let held: Uint8Array | undefined = key;
  let taken = false;
  return Object.freeze({
    take(): Uint8Array {
      if (taken || held === undefined) throw new Error("private generation key unavailable");
      taken = true;
      const owned = held;
      held = undefined;
      return owned;
    },
    dispose(): void {
      held?.fill(0);
      held = undefined;
    },
  });
}

/** Reads one bounded length-prefixed frame, then closes the pipe before another can be accepted. */
export function readP2PrivateProvisioningFrame(fd: number): Uint8Array {
  const readExact = (bytes: Uint8Array): void => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) throw new Error("incomplete private credential provisioning frame");
      offset += count;
    }
  };
  const prefix = new Uint8Array(4);
  let frame: Uint8Array | undefined;
  try {
    readExact(prefix);
    const length = new DataView(prefix.buffer).getUint32(0, false);
    if (length === 0 || length > P2_PRIVATE_PROVISIONING_FRAME_MAX_BYTES) {
      throw new Error("invalid private credential provisioning frame length");
    }
    frame = new Uint8Array(length);
    readExact(frame);
  } catch (error) {
    frame?.fill(0);
    prefix.fill(0);
    try {
      closeSync(fd);
    } catch {
      throw new Error("private credential provisioning pipe cleanup failed");
    }
    throw error;
  }
  prefix.fill(0);
  if (frame === undefined) throw new Error("private credential provisioning frame is missing");
  try {
    closeSync(fd);
  } catch {
    frame.fill(0);
    throw new Error("private credential provisioning pipe cleanup failed");
  }
  return frame;
}

export function p2GenerationToken(key: Uint8Array): string {
  if (key.byteLength !== P2_GENERATION_KEY_BYTES) {
    throw new TypeError("invalid private generation key");
  }
  return createHmac("sha256", key)
    .update("openomni.worker-generation-token.v1")
    .digest("base64url");
}

function boundedOwnArray(value: unknown): unknown[] | undefined {
  if (value === null || typeof value !== "object" || isProxy(value) || !Array.isArray(value))
    return undefined;
  const length = ownData(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_PROVISIONING_ITEMS
  )
    return undefined;
  if (Reflect.ownKeys(value).length !== length + 1) return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

function lengthPrefix(length: number): Uint8Array {
  const prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setBigUint64(0, BigInt(length));
  return prefix;
}

function privateCodecFailure(): never {
  throw new TypeError("invalid private credential provisioning frame");
}

function checkedString(value: unknown): Uint8Array {
  if (typeof value !== "string") privateCodecFailure();
  const bytes = encoder.encode(value);
  if (bytes.byteLength > MAX_PRIVATE_FIELD_BYTES) privateCodecFailure();
  return bytes;
}

function checkedSecret(value: unknown): Uint8Array {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    !(value instanceof Uint8Array) ||
    value.byteLength > MAX_PRIVATE_FIELD_BYTES
  ) {
    privateCodecFailure();
  }
  return value;
}

/** Deterministic binary codec for the secret-bearing supervisor-to-worker private pipe. */
export function encodeP2PrivateProvisioningFrame(frame: P2PrivateProvisioningFrame): Uint8Array {
  const frameInput = detachedOwnRecord(frame, ["peerIdentity", "authenticationTag", "credentials"]);
  if (frameInput === undefined) privateCodecFailure();
  const peer = detachedOwnRecord(frameInput.peerIdentity, [
    "runtimeId",
    "workerId",
    "generation",
    "principalId",
    "processId",
  ]);
  if (
    peer === undefined ||
    typeof peer.runtimeId !== "string" ||
    typeof peer.workerId !== "string" ||
    !Number.isSafeInteger(peer.generation) ||
    Number(peer.generation) < 0 ||
    typeof peer.principalId !== "string" ||
    !Number.isSafeInteger(peer.processId) ||
    Number(peer.processId) <= 0
  ) {
    privateCodecFailure();
  }
  const tag = checkedSecret(frameInput.authenticationTag);
  if (tag.byteLength !== HMAC_BYTES) privateCodecFailure();
  const inputs = boundedOwnArray(frameInput.credentials);
  if (inputs === undefined) privateCodecFailure();
  const fields: Uint8Array[] = [
    PRIVATE_FRAME_MAGIC,
    lengthPrefix(checkedString(peer.runtimeId).byteLength),
    checkedString(peer.runtimeId),
    lengthPrefix(checkedString(peer.workerId).byteLength),
    checkedString(peer.workerId),
    lengthPrefix(Number(peer.generation)),
    lengthPrefix(checkedString(peer.principalId).byteLength),
    checkedString(peer.principalId),
    lengthPrefix(Number(peer.processId)),
    tag,
    lengthPrefix(inputs.length),
  ];
  for (const input of inputs) {
    const materialInput = detachedOwnRecord(input, [
      "providerId",
      "credentialId",
      "authType",
      "secret",
      "baseURL",
    ]);
    if (materialInput === undefined) privateCodecFailure();
    const providerId = checkedString(materialInput.providerId);
    const credentialId = checkedString(materialInput.credentialId);
    const authType = materialInput.authType;
    fields.push(lengthPrefix(providerId.byteLength), providerId);
    fields.push(lengthPrefix(credentialId.byteLength), credentialId);
    if (authType === "api") {
      if (materialInput.baseURL !== undefined) privateCodecFailure();
      const secret = checkedSecret(materialInput.secret);
      fields.push(new Uint8Array([0]), lengthPrefix(secret.byteLength), secret);
    } else if (authType === "proxy") {
      const baseURL = checkedString(materialInput.baseURL);
      const secretInput = materialInput.secret;
      fields.push(new Uint8Array([1]), lengthPrefix(baseURL.byteLength), baseURL);
      if (secretInput === undefined) {
        fields.push(new Uint8Array([0]));
      } else {
        const secret = checkedSecret(secretInput);
        fields.push(new Uint8Array([1]), lengthPrefix(secret.byteLength), secret);
      }
    } else {
      privateCodecFailure();
    }
  }
  const byteLength = fields.reduce((total, field) => total + field.byteLength, 0);
  if (byteLength > P2_PRIVATE_PROVISIONING_FRAME_MAX_BYTES) privateCodecFailure();
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const field of fields) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

/** Parses only bounded byte slices; malformed input cannot execute object traps or allocate by claimed size. */
export function decodeP2PrivateProvisioningFrame(bytes: Uint8Array): P2PrivateProvisioningFrame {
  if (
    bytes === null ||
    typeof bytes !== "object" ||
    isProxy(bytes) ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > P2_PRIVATE_PROVISIONING_FRAME_MAX_BYTES
  ) {
    if (bytes instanceof Uint8Array && !isProxy(bytes)) bytes.fill(0);
    privateCodecFailure();
  }
  let offset = 0;
  const sensitiveCopies: Uint8Array[] = [];
  const take = (length: number, sensitive = false): Uint8Array => {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.byteLength - offset) {
      privateCodecFailure();
    }
    const result = bytes.slice(offset, offset + length);
    offset += length;
    if (sensitive) sensitiveCopies.push(result);
    return result;
  };
  const uint64 = (fieldLimit = MAX_PRIVATE_FIELD_BYTES): number => {
    const encoded = take(8);
    const value = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getBigUint64(
      0,
    );
    if (value > BigInt(fieldLimit)) privateCodecFailure();
    return Number(value);
  };
  try {
    const magic = take(PRIVATE_FRAME_MAGIC.byteLength);
    if (!magic.every((byte, index) => byte === PRIVATE_FRAME_MAGIC[index])) privateCodecFailure();
    const text = (): string => decoder.decode(take(uint64()));
    const peerIdentity: P2ProvisioningPeerIdentity = {
      runtimeId: text(),
      workerId: text(),
      generation: uint64(Number.MAX_SAFE_INTEGER),
      principalId: text(),
      processId: uint64(Number.MAX_SAFE_INTEGER),
    };
    if (peerIdentity.processId !== process.pid || peerIdentity.processId <= 0)
      privateCodecFailure();
    const authenticationTag = take(HMAC_BYTES, true);
    const count = uint64(MAX_PROVISIONING_ITEMS);
    const credentials: ProvisionedCredentialMaterial[] = [];
    for (let index = 0; index < count; index += 1) {
      const providerId = text();
      const credentialId = text();
      const authType = take(1)[0];
      if (authType === 0) {
        credentials.push({
          providerId,
          credentialId,
          authType: "api",
          secret: take(uint64(), true),
        });
      } else if (authType === 1) {
        const baseURL = text();
        const secretPresent = take(1)[0];
        if (secretPresent === 0) {
          credentials.push({ providerId, credentialId, authType: "proxy", baseURL });
        } else if (secretPresent === 1) {
          credentials.push({
            providerId,
            credentialId,
            authType: "proxy",
            baseURL,
            secret: take(uint64(), true),
          });
        } else {
          privateCodecFailure();
        }
      } else {
        privateCodecFailure();
      }
    }
    if (offset !== bytes.byteLength) privateCodecFailure();
    return { peerIdentity, authenticationTag, credentials };
  } catch {
    for (const copy of sensitiveCopies) copy.fill(0);
    bytes.fill(0);
    privateCodecFailure();
  }
}

function authenticatedBytes(
  request: Execution.CredentialProvisioningRequestV1,
  peerIdentity: P2ProvisioningPeerIdentity,
  credentials: readonly ProvisionedCredentialMaterial[],
): Uint8Array {
  const fields: Uint8Array[] = [
    encoder.encode("openomni.credential-provisioning.r10"),
    encoder.encode(JSON.stringify(canonicalValue(request))),
    encoder.encode(JSON.stringify(canonicalValue(peerIdentity))),
    encoder.encode(String(credentials.length)),
  ];
  for (const [index, material] of credentials.entries()) {
    fields.push(
      encoder.encode(String(index)),
      encoder.encode(material.providerId),
      encoder.encode(material.credentialId),
      encoder.encode(material.authType),
    );
    if (material.authType === "api") {
      fields.push(encoder.encode("secret-present"), material.secret);
    } else {
      fields.push(
        encoder.encode(material.secret === undefined ? "secret-absent" : "secret-present"),
        encoder.encode(material.baseURL),
      );
      if (material.secret !== undefined) fields.push(material.secret);
    }
  }
  const byteLength = fields.reduce((total, field) => total + 8 + field.byteLength, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const field of fields) {
    const prefix = lengthPrefix(field.byteLength);
    output.set(prefix, offset);
    offset += prefix.byteLength;
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

/** Sender-side construction helper. Credential bytes remain caller-owned. A local signer is one-shot. */
export function p2ProvisioningAuthenticationTag(
  keyOrSigner: Uint8Array | P2ProvisioningAuthenticationSigner,
  request: Execution.CredentialProvisioningRequestV1,
  peerIdentity: P2ProvisioningPeerIdentity,
  credentials: readonly ProvisionedCredentialMaterial[],
): Uint8Array {
  if (boundedOwnArray(credentials) === undefined) throw new P2ProvisioningDeniedError();
  const bytes = authenticatedBytes(request, peerIdentity, credentials);
  try {
    if (keyOrSigner instanceof Uint8Array) {
      return new Uint8Array(createHmac("sha256", keyOrSigner).update(bytes).digest());
    }
    const context = keyOrSigner.context;
    if (
      context.runtimeId !== peerIdentity.runtimeId ||
      context.workerId !== peerIdentity.workerId ||
      context.generation !== peerIdentity.generation ||
      context.principalId !== peerIdentity.principalId ||
      !Number.isSafeInteger(context.processId) ||
      context.processId <= 0 ||
      context.processId !== peerIdentity.processId ||
      !sameValue(context.attempt, request.attempt)
    ) {
      throw new P2ProvisioningDeniedError();
    }
    const tag = keyOrSigner.sign(bytes);
    if (!(tag instanceof Uint8Array) || tag.byteLength !== HMAC_BYTES) {
      if (tag instanceof Uint8Array) tag.fill(0);
      throw new P2ProvisioningDeniedError();
    }
    return tag;
  } finally {
    bytes.fill(0);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function sameProviderSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((providerId, index) => providerId === sortedRight[index]);
}

function deny(): never {
  throw new P2ProvisioningDeniedError();
}

function fail(code: string, cause?: unknown): never {
  throw new P2ProvisioningInternalFailure(code, cause);
}

function ownData(value: object, key: string): unknown {
  if (isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function parseFrame(frame: unknown): {
  readonly request: Execution.CredentialProvisioningRequestV1;
  readonly peerIdentity: P2ProvisioningPeerIdentity;
  readonly authenticationTag: Uint8Array;
  readonly credentials: readonly ProvisionedCredentialMaterial[];
} {
  const frameInput = detachedOwnRecord(frame, [
    "request",
    "peerIdentity",
    "authenticationTag",
    "credentials",
  ]);
  if (frameInput === undefined) fail("FRAME_INVALID");
  const rawRequest = frameInput.request;
  const peerIdentity = frameInput.peerIdentity;
  const authenticationTag = frameInput.authenticationTag;
  const credentialInputs = boundedOwnArray(frameInput.credentials);
  const peer = detachedOwnRecord(peerIdentity, [
    "runtimeId",
    "workerId",
    "generation",
    "principalId",
    "processId",
  ]);
  const requestInput = detachedOwnRecord(rawRequest, [
    "version",
    "runtimeId",
    "workerId",
    "generation",
    "principalId",
    "attempt",
    "providerIds",
    "nonceRef",
    "expiresAt",
    "credentialRefs",
  ]);
  if (requestInput === undefined || credentialInputs === undefined) fail("FRAME_INVALID");
  const requestAttempt = detachedOwnRecord(requestInput.attempt, [
    "version",
    "workItemId",
    "attemptId",
    "attemptSeq",
  ]);
  const requestProviderIds = boundedOwnArray(requestInput.providerIds);
  const requestCredentialInputs = boundedOwnArray(requestInput.credentialRefs);
  const requestCredentialRefs = requestCredentialInputs?.map((ref) =>
    detachedOwnRecord(ref, [
      "version",
      "providerId",
      "authType",
      "credentialId",
      "rotationId",
      "account",
      "sourceKind",
      "sourcePathDigest",
      "endpointRef",
      "credentialDigest",
    ]),
  );
  if (
    requestAttempt === undefined ||
    requestProviderIds === undefined ||
    requestCredentialRefs === undefined ||
    requestCredentialRefs.some((ref) => ref === undefined)
  )
    fail("FRAME_INVALID");
  requestInput.attempt = requestAttempt;
  requestInput.providerIds = requestProviderIds;
  requestInput.credentialRefs = requestCredentialRefs;
  const request = Execution.CredentialProvisioningRequestV1.safeParse(requestInput);
  if (
    !request.success ||
    peer === undefined ||
    typeof peer.runtimeId !== "string" ||
    typeof peer.workerId !== "string" ||
    typeof peer.generation !== "number" ||
    !Number.isSafeInteger(peer.generation) ||
    typeof peer.principalId !== "string" ||
    typeof peer.processId !== "number" ||
    !Number.isSafeInteger(peer.processId) ||
    peer.processId <= 0 ||
    authenticationTag === null ||
    typeof authenticationTag !== "object" ||
    isProxy(authenticationTag) ||
    !(authenticationTag instanceof Uint8Array) ||
    authenticationTag.byteLength !== HMAC_BYTES
  )
    fail("FRAME_INVALID");
  const materials: ProvisionedCredentialMaterial[] = [];
  for (const material of credentialInputs) {
    const materialInput = detachedOwnRecord(material, [
      "providerId",
      "credentialId",
      "authType",
      "secret",
      "baseURL",
    ]);
    if (materialInput === undefined) fail("FRAME_INVALID");
    const { providerId, credentialId, authType, secret, baseURL } = materialInput;
    if (
      typeof providerId !== "string" ||
      typeof credentialId !== "string" ||
      (authType !== "api" && authType !== "proxy") ||
      (authType === "api" &&
        (baseURL !== undefined ||
          secret === null ||
          typeof secret !== "object" ||
          isProxy(secret) ||
          !(secret instanceof Uint8Array))) ||
      (authType === "proxy" &&
        (typeof baseURL !== "string" ||
          (secret !== undefined &&
            (secret === null ||
              typeof secret !== "object" ||
              isProxy(secret) ||
              !(secret instanceof Uint8Array)))))
    )
      fail("FRAME_INVALID");
    materials.push(
      authType === "api"
        ? { providerId, credentialId, authType, secret: secret as Uint8Array }
        : {
            providerId,
            credentialId,
            authType,
            baseURL: baseURL as string,
            ...(secret === undefined ? {} : { secret: secret as Uint8Array }),
          },
    );
  }
  return {
    request: request.data,
    peerIdentity: peer as unknown as P2ProvisioningPeerIdentity,
    authenticationTag,
    credentials: materials,
  };
}

function scrubFrame(frame: unknown): unknown {
  let failure: unknown;
  try {
    if (frame === null || typeof frame !== "object") return undefined;
    const authenticationTag = ownData(frame, "authenticationTag");
    if (
      authenticationTag !== null &&
      typeof authenticationTag === "object" &&
      !isProxy(authenticationTag) &&
      authenticationTag instanceof Uint8Array
    ) {
      const tagFailure = cleanupFailure(() => authenticationTag.fill(0));
      failure ??= tagFailure;
    }
    const credentials = ownData(frame, "credentials");
    if (Array.isArray(credentials) && !isProxy(credentials)) {
      for (const key of Reflect.ownKeys(credentials)) {
        if (typeof key !== "string" || key === "length" || !/^(0|[1-9]\d*)$/u.test(key)) continue;
        try {
          const material = ownData(credentials, key);
          if (material === null || typeof material !== "object" || isProxy(material)) continue;
          const secret = ownData(material, "secret");
          if (
            secret !== null &&
            typeof secret === "object" &&
            !isProxy(secret) &&
            secret instanceof Uint8Array
          ) {
            const secretFailure = cleanupFailure(() => secret.fill(0));
            failure ??= secretFailure;
          }
        } catch (error) {
          failure ??= error;
        }
      }
    }
  } catch (error) {
    failure ??= error;
  }
  return failure;
}
function cleanupFailure(cleanup: () => void): unknown {
  try {
    cleanup();
    return undefined;
  } catch (error) {
    return error;
  }
}

export function createP2WorkerCredentialProvisioner(
  binding: P2ProvisioningBinding,
): P2WorkerCredentialProvisioner {
  const key = binding.keyMaterial.take();
  const boundProcessId = binding.processId ?? process.pid;
  let sanitizer: BoundarySanitizer;
  let registry: SecretRegistry;
  try {
    sanitizer = BoundarySanitizer.create();
    registry = SecretRegistry.create(sanitizer);
  } catch (error) {
    key.fill(0);
    try {
      binding.keyMaterial.dispose();
    } catch {
      // The public denial remains secret-free even when custody cleanup also fails.
    }
    throw new P2ProvisioningDeniedError(
      new P2ProvisioningInternalFailure("PROVISIONER_INITIALIZATION_FAILED", error),
    );
  }
  const handles = new Map<string, SecretHandle>();
  let terminal = false;
  let keyDisposed = false;
  let resourcesDisposed = false;
  let resourceCleanupError: P2ProvisioningCleanupError | undefined;
  let disposeCalled = false;

  const sanitizeFailure = (boundary: string, error: Error): Error => {
    try {
      return sanitizer.sanitizeError(boundary, error);
    } catch {
      return new P2ProvisioningInternalFailure(
        error instanceof P2ProvisioningInternalFailure ? error.code : "UNEXPECTED_FAILURE",
      );
    }
  };

  const scrubKey = (): unknown => {
    let failure: unknown;
    try {
      key.fill(0);
    } catch (error) {
      failure = error;
    }
    if (!keyDisposed) {
      keyDisposed = true;
      try {
        binding.keyMaterial.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  };

  const disposeResources = (): P2ProvisioningCleanupError | undefined => {
    if (resourcesDisposed) return resourceCleanupError;
    resourcesDisposed = true;
    disposeCalled = true;
    terminal = true;
    handles.clear();

    let firstFailure = scrubKey();
    const registryFailure = cleanupFailure(() => registry.dispose());
    firstFailure ??= registryFailure;
    if (firstFailure !== undefined) {
      let sanitized: Error;
      try {
        sanitized = sanitizer.sanitizeError(
          "worker-credential-cleanup",
          new P2ProvisioningInternalFailure("CLEANUP_FAILED", firstFailure),
        );
      } catch {
        sanitized = new P2ProvisioningInternalFailure("CLEANUP_FAILED");
      }
      resourceCleanupError = new P2ProvisioningCleanupError(sanitized);
    }

    const sanitizerFailure = cleanupFailure(() => sanitizer.dispose());
    if (resourceCleanupError === undefined && sanitizerFailure !== undefined) {
      resourceCleanupError = new P2ProvisioningCleanupError(
        new P2ProvisioningInternalFailure("CLEANUP_FAILED"),
      );
    }
    return resourceCleanupError;
  };

  const dispose = (): void => {
    if (disposeCalled) return;
    disposeCalled = true;
    const cleanupError = disposeResources();
    if (cleanupError !== undefined) throw cleanupError;
  };

  const provision = (
    input: P2CredentialProvisioningFrame,
  ): Execution.CredentialProvisioningReceiptV1 => {
    let receipt: Execution.CredentialProvisioningReceiptV1 | undefined;
    let primaryFailure: P2ProvisioningInternalFailure | undefined;
    try {
      if (terminal) fail("PROVISIONER_TERMINAL");
      const bindingProviderIds = boundedOwnArray(binding.providerIds);
      const bindingCredentialRefs = boundedOwnArray(binding.credentialRefs);
      if (bindingProviderIds === undefined || bindingCredentialRefs === undefined)
        fail("BINDING_INVALID");
      if (key.byteLength < HMAC_BYTES) fail("PROVISIONER_TERMINAL");
      const frame = parseFrame(input);
      const { request } = frame;
      const expectedTag = p2ProvisioningAuthenticationTag(
        key,
        request,
        frame.peerIdentity,
        frame.credentials,
      );
      let macMatches = false;
      try {
        macMatches =
          frame.authenticationTag.byteLength === HMAC_BYTES &&
          timingSafeEqual(frame.authenticationTag, expectedTag);
      } finally {
        expectedTag.fill(0);
      }
      if (!macMatches) fail("AUTHENTICATION_FAILED");

      const nowDbMs = binding.nowDbMs();
      if (
        !sameValue(frame.peerIdentity, {
          runtimeId: binding.runtimeId,
          workerId: binding.workerId,
          generation: binding.generation,
          principalId: binding.principalId,
          processId: boundProcessId,
        }) ||
        boundProcessId !== process.pid ||
        request.runtimeId !== binding.runtimeId ||
        request.workerId !== binding.workerId ||
        request.generation !== binding.generation ||
        request.principalId !== binding.principalId ||
        request.nonceRef !== binding.nonceRef ||
        !sameValue(request.attempt, binding.attempt) ||
        !sameProviderSet(request.providerIds, bindingProviderIds as string[]) ||
        !sameValue(
          [...request.credentialRefs].sort((left, right) =>
            left.providerId.localeCompare(right.providerId),
          ),
          [...(bindingCredentialRefs as Execution.CredentialSourceRefV1[])].sort((left, right) =>
            left.providerId.localeCompare(right.providerId),
          ),
        ) ||
        request.expiresAt <= nowDbMs
      ) {
        fail("BINDING_MISMATCH");
      }
      if (frame.credentials.length !== request.providerIds.length) fail("CREDENTIAL_SET_MISMATCH");

      const byProvider = new Map<string, ProvisionedCredentialMaterial>();
      for (const material of frame.credentials) {
        if (
          byProvider.has(material.providerId) ||
          !request.providerIds.includes(material.providerId)
        )
          fail("CREDENTIAL_SET_MISMATCH");
        byProvider.set(material.providerId, material);
      }
      if (!binding.nonces.consume(request.nonceRef)) fail("NONCE_REPLAY");

      const pending: Array<readonly [string, SecretHandle, Execution.CredentialSourceRefV1]> = [];
      for (const ref of request.credentialRefs) {
        const material = byProvider.get(ref.providerId);
        if (
          material === undefined ||
          material.credentialId !== ref.credentialId ||
          material.authType !== ref.authType
        )
          fail("CREDENTIAL_BINDING_MISMATCH");
        const auth =
          material.authType === "api"
            ? { type: "api" as const, key: material.secret }
            : {
                type: "proxy" as const,
                baseURL: material.baseURL,
                ...(material.secret === undefined ? {} : { apiKey: material.secret }),
              };
        try {
          const source = CredentialSource.parseOwner({
            providerId: ref.providerId,
            credentialId: ref.credentialId,
            rotationId: ref.rotationId,
            ...(ref.account === undefined ? {} : { account: ref.account }),
            sourceKind: "injected_runtime",
            ...(ref.endpointRef === undefined ? {} : { endpointRef: ref.endpointRef }),
            auth,
          });
          const registered = registry.register(source);
          if (!sameValue(registered.ref, ref)) fail("CREDENTIAL_BINDING_MISMATCH");
          pending.push([ref.providerId, registered.handle, registered.ref]);
        } catch (error) {
          if (
            error instanceof P2ProvisioningInternalFailure &&
            error.code === "CREDENTIAL_BINDING_MISMATCH"
          )
            throw error;
          fail("MATERIAL_REGISTRATION_FAILED", error);
        }
      }
      for (const [providerId, handle] of pending) handles.set(providerId, handle);
      receipt = Execution.CredentialProvisioningReceiptV1.parse({
        version: "credential-provisioning-receipt-v1",
        runtimeId: request.runtimeId,
        workerId: request.workerId,
        generation: request.generation,
        principalId: request.principalId,
        attempt: request.attempt,
        nonceRef: request.nonceRef,
        acceptedCredentialDigests: pending.map(([, , ref]) => ref.credentialDigest),
        acceptedAtDbMs: nowDbMs,
      });
    } catch (error) {
      primaryFailure =
        error instanceof P2ProvisioningInternalFailure
          ? error
          : new P2ProvisioningInternalFailure("UNEXPECTED_FAILURE", error);
    }

    terminal = true;
    const keyCleanupFailure = scrubKey();
    const frameCleanupFailure = scrubFrame(input);
    const cleanupCause = keyCleanupFailure ?? frameCleanupFailure;
    let primary =
      primaryFailure === undefined
        ? undefined
        : sanitizeFailure("worker-credential-provisioning", primaryFailure);
    let cleanup =
      cleanupCause === undefined
        ? undefined
        : sanitizeFailure(
            "worker-credential-provisioning-cleanup",
            new P2ProvisioningInternalFailure("CLEANUP_FAILED", cleanupCause),
          );
    if (primary !== undefined || cleanup !== undefined) {
      const resourceFailure = disposeResources();
      if (cleanup === undefined && resourceFailure !== undefined) {
        cleanup = new P2ProvisioningInternalFailure("CLEANUP_FAILED");
      }
      if (primary !== undefined && cleanup !== undefined) {
        const code =
          primary instanceof P2ProvisioningInternalFailure
            ? primary.code
            : (primaryFailure?.code ?? "UNEXPECTED_FAILURE");
        primary = new P2ProvisioningInternalFailure(code, primary, cleanup);
      }
      throw new P2ProvisioningDeniedError(primary ?? cleanup);
    }
    return receipt as Execution.CredentialProvisioningReceiptV1;
  };

  const withProviderCredential = async <T>(
    providerId: string,
    use: (credential: MaterializedCredential) => T | Promise<T>,
  ): Promise<T> => {
    const handle = handles.get(providerId);
    if (handle === undefined) deny();
    try {
      return await registry.withMaterialized(handle, providerId, use);
    } catch (error) {
      throw sanitizeFailure(
        "worker-provider-materialization",
        error instanceof Error ? error : new P2ProvisioningInternalFailure("UNEXPECTED_FAILURE"),
      );
    }
  };

  const credentialHandle = (providerId: string): SecretHandle => {
    const handle = handles.get(providerId);
    if (handle === undefined) deny();
    return handle;
  };

  return Object.freeze({
    sanitizer,
    registry,
    provision,
    credentialHandle,
    withProviderCredential,
    dispose,
  });
}

function detachedOwnRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value))
    return undefined;
  const allowed = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length > keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
  )
    return undefined;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) output[key] = ownData(value, key);
  return output;
}
function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) output[key] = ownData(value, key);
  return output;
}

function inert(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(inert));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      output[key] = inert((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(output);
  }
  return value;
}

const invalidDiagnosticRequest = inert({
  version: "invalid-credential-provisioning-request",
});
const invalidDiagnosticPeer = inert({ version: "invalid-provisioning-peer" });
const invalidDiagnosticCredentials = Object.freeze([
  inert({ version: "invalid-credential-material" }),
]);

/** Safe diagnostic metadata: detached own-data records with no MAC, secret, endpoint, or input refs. */
export function describeP2ProvisioningFrame(
  frame: P2CredentialProvisioningFrame,
): Readonly<Record<string, unknown>> {
  let request: unknown = invalidDiagnosticRequest;
  let peerIdentity: unknown = invalidDiagnosticPeer;
  let credentials: readonly unknown[] = invalidDiagnosticCredentials;
  try {
    const requestInput = ownRecord(ownData(frame, "request"), [
      "version",
      "runtimeId",
      "workerId",
      "generation",
      "principalId",
      "attempt",
      "providerIds",
      "nonceRef",
      "expiresAt",
      "credentialRefs",
    ]);
    if (requestInput !== undefined) {
      requestInput.attempt = ownRecord(requestInput.attempt, [
        "version",
        "workItemId",
        "attemptId",
        "attemptSeq",
      ]);
      requestInput.providerIds = boundedOwnArray(requestInput.providerIds);
      const refs = boundedOwnArray(requestInput.credentialRefs);
      requestInput.credentialRefs = refs?.map((ref) =>
        ownRecord(ref, [
          "version",
          "providerId",
          "authType",
          "credentialId",
          "rotationId",
          "account",
          "sourceKind",
          "sourcePathDigest",
          "credentialDigest",
          "endpointRef",
        ]),
      );
      const parsed = Execution.CredentialProvisioningRequestV1.safeParse(requestInput);
      if (parsed.success) request = inert(parsed.data);
    }

    const peer = ownRecord(ownData(frame, "peerIdentity"), [
      "runtimeId",
      "workerId",
      "generation",
      "principalId",
      "processId",
    ]);
    if (
      peer !== undefined &&
      typeof peer.runtimeId === "string" &&
      typeof peer.workerId === "string" &&
      typeof peer.generation === "number" &&
      Number.isSafeInteger(peer.generation) &&
      typeof peer.principalId === "string" &&
      typeof peer.processId === "number" &&
      Number.isSafeInteger(peer.processId) &&
      peer.processId > 0
    ) {
      peerIdentity = inert(peer);
    }

    const materialInputs = boundedOwnArray(ownData(frame, "credentials"));
    if (materialInputs !== undefined) {
      credentials = Object.freeze(
        materialInputs.map((material) => {
          const data = ownRecord(material, ["providerId", "credentialId", "authType"]);
          if (
            data === undefined ||
            typeof data.providerId !== "string" ||
            typeof data.credentialId !== "string" ||
            (data.authType !== "api" && data.authType !== "proxy")
          ) {
            return inert({ version: "invalid-credential-material" });
          }
          return inert({ ...data, secret: "[REDACTED]" });
        }),
      );
    }
  } catch {
    request = invalidDiagnosticRequest;
    peerIdentity = invalidDiagnosticPeer;
    credentials = invalidDiagnosticCredentials;
  }
  return inert({
    request,
    peerIdentity,
    authenticationTag: "[REDACTED]",
    credentials,
  }) as Readonly<Record<string, unknown>>;
}

export function p2ProvisioningBytes(value: string): Uint8Array {
  return encoder.encode(value);
}
