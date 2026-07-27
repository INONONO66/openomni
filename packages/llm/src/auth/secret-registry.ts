import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { Execution } from "@openomni/protocol";
import type { BoundarySanitizer, SanitizedValue } from "./boundary-sanitizer";
import type { OwnerCredentialSource } from "./credential-source";

const HANDLE_BRAND: unique symbol = Symbol("SecretRegistry.Handle");
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const encoder = new TextEncoder();
const HANDLE_SANITIZERS = new WeakMap<object, BoundarySanitizer>();
const SANITIZER_REGISTRIES = new WeakMap<BoundarySanitizer, SecretRegistry>();
const REGISTRY_SANITIZERS = new WeakMap<SecretRegistry, BoundarySanitizer>();
const ACTIVE_REGISTRIES = new WeakSet<SecretRegistry>();

/** Trap-inert identity and lifecycle check for composition roots. */
function isSecretRegistrySanitizerPair(
  registry: SecretRegistry,
  sanitizer: BoundarySanitizer,
): boolean {
  if (isProxy(registry) || isProxy(sanitizer)) return false;
  if (REGISTRY_SANITIZERS.get(registry) !== sanitizer || !ACTIVE_REGISTRIES.has(registry))
    return false;
  try {
    sanitizer.assertActive();
    return true;
  } catch {
    return false;
  }
}

/** Query-only identity check used by BoundarySanitizer; registration remains registry-owned. */
export function isRegisteredSecretHandle(value: object, sanitizer: BoundarySanitizer): boolean {
  return HANDLE_SANITIZERS.get(value) === sanitizer;
}

type StoredMetadata = Readonly<{
  providerId: string;
  authType: "api" | "proxy";
  baseURL?: string;
  ref: Execution.CredentialSourceRefV1;
}>;

type StoredSecret = {
  readonly metadata: StoredMetadata;
  readonly secret?: Uint8Array;
};

export interface SecretHandle {
  readonly [HANDLE_BRAND]: true;
  readonly providerId: string;
  readonly credentialId: string;
  toJSON(): never;
  toString(): string;
}

export type MaterializedCredential =
  | Readonly<{ providerId: string; authType: "api"; key: Uint8Array }>
  | Readonly<{ providerId: string; authType: "proxy"; baseURL: string; apiKey?: Uint8Array }>;

export class SecretRegistryError extends Error {
  readonly code:
    | "UNKNOWN_HANDLE"
    | "PROVIDER_SCOPE_MISMATCH"
    | "DISPOSED"
    | "INVALID_SANITIZER"
    | "SANITIZER_ALREADY_CLAIMED";

  constructor(code: SecretRegistryError["code"], message: string) {
    super(message);
    this.name = "SecretRegistryError";
    this.code = code;
  }
}

export class SecretHandleSerializationError extends Error {
  constructor() {
    super("secret custody objects cannot be serialized");
    this.name = "SecretHandleSerializationError";
  }
}

function digest(
  domain: string,
  fields: readonly (readonly [string, string | undefined])[],
): string {
  const hash = createHash("sha256");
  const add = (value: string) => {
    const bytes = encoder.encode(value);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  };
  add(domain);
  for (const [name, value] of fields) {
    add(name);
    add(value ?? "");
  }
  return hash.digest("hex");
}

function credentialRef(source: OwnerCredentialSource): Execution.CredentialSourceRefV1 {
  const sourcePathDigest = digest("openomni.security.credential-source-path.v1", [
    ["sourceKind", source.sourceKind],
    ["sourcePath", source.sourcePath],
  ]);
  const credentialDigest = digest("openomni.security.credential-source-ref.v1", [
    ["providerId", source.providerId],
    ["authType", source.auth.type],
    ["credentialId", source.credentialId],
    ["rotationId", source.rotationId],
    ["account", source.account],
    ["sourceKind", source.sourceKind],
    ["endpointRef", source.endpointRef],
  ]);
  return Object.freeze(
    Execution.CredentialSourceRefV1.parse({
      version: "credential-source-ref-v1",
      providerId: source.providerId,
      authType: source.auth.type,
      credentialId: source.credentialId,
      rotationId: source.rotationId,
      ...(source.account === undefined ? {} : { account: source.account }),
      sourceKind: source.sourceKind,
      sourcePathDigest,
      ...(source.endpointRef === undefined ? {} : { endpointRef: source.endpointRef }),
      credentialDigest,
    }),
  );
}

export class SecretRegistry {
  readonly #entries = new WeakMap<SecretHandle, StoredSecret>();
  readonly #retained = new Set<StoredSecret>();
  readonly #sanitizer: BoundarySanitizer;
  #disposed = false;

  readonly toJSON = (): never => {
    throw new SecretHandleSerializationError();
  };

  readonly [INSPECT] = (): string => "[SecretRegistry]";

  private constructor(sanitizer: BoundarySanitizer) {
    this.#sanitizer = sanitizer;
  }

  static isSanitizerPair(registry: SecretRegistry, sanitizer: BoundarySanitizer): boolean {
    return isSecretRegistrySanitizerPair(registry, sanitizer);
  }
  static create(sanitizer: BoundarySanitizer): SecretRegistry {
    if (isProxy(sanitizer))
      throw new SecretRegistryError("INVALID_SANITIZER", "sanitizer must not be a proxy");
    if (SANITIZER_REGISTRIES.has(sanitizer)) {
      throw new SecretRegistryError(
        "SANITIZER_ALREADY_CLAIMED",
        "BoundarySanitizer is already claimed by a SecretRegistry",
      );
    }
    sanitizer.assertActive();
    const registry = new SecretRegistry(sanitizer);
    SANITIZER_REGISTRIES.set(sanitizer, registry);
    REGISTRY_SANITIZERS.set(registry, sanitizer);
    ACTIVE_REGISTRIES.add(registry);
    return registry;
  }

  register(
    source: OwnerCredentialSource,
  ): Readonly<{ handle: SecretHandle; ref: Execution.CredentialSourceRefV1 }> {
    const rawSecret = source.auth.type === "api" ? source.auth.key : source.auth.apiKey;
    let secret: Uint8Array | undefined;
    try {
      if (this.#disposed) throw new SecretRegistryError("DISPOSED", "SecretRegistry is disposed");
      const ref = credentialRef(source);
      secret =
        rawSecret === undefined
          ? undefined
          : typeof rawSecret === "string"
            ? encoder.encode(rawSecret)
            : new Uint8Array(rawSecret);
      this.#sanitizer.assertActive();
      if (rawSecret !== undefined) this.#sanitizer.registerExactSecret(rawSecret);
      const metadata: StoredMetadata = Object.freeze({
        providerId: source.providerId,
        authType: source.auth.type,
        ...(source.auth.type === "proxy" ? { baseURL: source.auth.baseURL } : {}),
        ref,
      });
      const handle = Object.freeze({
        [HANDLE_BRAND]: true as const,
        providerId: source.providerId,
        credentialId: source.credentialId,
        toJSON(): never {
          throw new SecretHandleSerializationError();
        },
        toString(): string {
          return "[SecretHandle]";
        },
        [INSPECT](): string {
          return "[SecretHandle]";
        },
        [Symbol.toPrimitive](): string {
          return "[SecretHandle]";
        },
      });
      HANDLE_SANITIZERS.set(handle, this.#sanitizer);
      const entry: StoredSecret = { metadata, secret };
      this.#entries.set(handle, entry);
      this.#retained.add(entry);
      return Object.freeze({ handle, ref });
    } catch (error) {
      secret?.fill(0);
      throw error;
    } finally {
      if (rawSecret instanceof Uint8Array) rawSecret.fill(0);
    }
  }

  describe(handle: SecretHandle): Execution.CredentialSourceRefV1 {
    return this.#entry(handle).metadata.ref;
  }

  sanitizeText(boundary: string, value: string): string {
    if (this.#disposed) throw new SecretRegistryError("DISPOSED", "SecretRegistry is disposed");
    return this.#sanitizer.sanitizeText(boundary, value);
  }

  sanitizeError(boundary: string, value: unknown): Error {
    if (this.#disposed) throw new SecretRegistryError("DISPOSED", "SecretRegistry is disposed");
    return this.#sanitizer.sanitizeError(boundary, value);
  }

  sanitizeValue(boundary: string, value: unknown): SanitizedValue {
    if (this.#disposed) throw new SecretRegistryError("DISPOSED", "SecretRegistry is disposed");
    return this.#sanitizer.sanitizeValue(boundary, value);
  }

  async withMaterialized<T>(
    handle: SecretHandle,
    providerId: string,
    use: (credential: MaterializedCredential) => T | Promise<T>,
  ): Promise<T> {
    const entry = this.#entry(handle);
    if (entry.metadata.providerId !== providerId) {
      throw new SecretRegistryError(
        "PROVIDER_SCOPE_MISMATCH",
        `credential is scoped to provider ${entry.metadata.providerId}`,
      );
    }

    const buffer = entry.secret === undefined ? undefined : new Uint8Array(entry.secret);
    const credential: MaterializedCredential =
      entry.metadata.authType === "api"
        ? Object.freeze({ providerId, authType: "api", key: buffer as Uint8Array })
        : Object.freeze({
            providerId,
            authType: "proxy",
            baseURL: entry.metadata.baseURL as string,
            ...(buffer === undefined ? {} : { apiKey: buffer }),
          });
    try {
      return await use(credential);
    } finally {
      buffer?.fill(0);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    ACTIVE_REGISTRIES.delete(this);
    for (const entry of this.#retained) entry.secret?.fill(0);
    this.#retained.clear();
    this.#sanitizer.dispose();
  }

  #entry(handle: SecretHandle): StoredSecret {
    if (this.#disposed) throw new SecretRegistryError("DISPOSED", "SecretRegistry is disposed");
    this.#sanitizer.assertActive();
    const entry = this.#entries.get(handle);
    if (!entry) throw new SecretRegistryError("UNKNOWN_HANDLE", "unknown SecretRegistry handle");
    return entry;
  }
}

// Mutable source, registry, sanitizer-match, and materialization buffers are
// scrubbed at their custody boundaries. JavaScript strings, including exact
// sanitizer match forms and copies retained by provider SDKs, cannot be
// reliably zeroized; they remain subject to GC and callbacks must stay narrow.
