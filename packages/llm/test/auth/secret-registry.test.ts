import { inspect } from "node:util";
import { describe, expect, it } from "bun:test";
import {
  BoundarySanitizer,
  BoundarySanitizerError,
  CredentialSource,
  CredentialSourceError,
  SecretHandleSerializationError,
  SecretRegistry,
  SecretRegistryError,
  type SanitizedValue,
} from "../../src/auth";

function source(secret: string | Uint8Array, rotationId = "rotation-1") {
  return CredentialSource.parseOwner({
    providerId: "openai",
    credentialId: "owner-openai",
    rotationId,
    sourceKind: "injected_runtime",
    auth: { type: "api", key: secret },
  });
}

describe("revision-9 SecretRegistry custody", () => {
  it("strictly parses metadata and normalizes only secret-free proxy URLs", () => {
    expect(() =>
      CredentialSource.parseOwner({
        providerId: "openai",
        credentialId: "owner-openai",
        sourceKind: "injected_runtime",
        auth: { type: "api", key: "canary" },
      }),
    ).toThrow(CredentialSourceError);
    try {
      CredentialSource.parseOwner({
        providerId: "openai",
        credentialId: "owner-openai",
        sourceKind: "injected_runtime",
        auth: { type: "api", key: "canary" },
      });
    } catch (error) {
      expect((error as CredentialSourceError).code).toBe("MISSING_ROTATION_METADATA");
    }
    expect(() => CredentialSource.parseOwner({ ...source("canary"), unexpected: true })).toThrow(
      CredentialSourceError,
    );

    const proxy = CredentialSource.parseOwner({
      providerId: "proxy",
      credentialId: "owner-proxy",
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "proxy", baseURL: "https://EXAMPLE.com/v1", apiKey: "proxy-canary" },
    });
    expect(proxy.auth.type === "proxy" && proxy.auth.baseURL).toBe("https://example.com/v1");
    expect(proxy.endpointRef).toBe("proxy:https://example.com/v1");
    for (const baseURL of [
      "not a url",
      "ftp://example.com/v1",
      "https://user:password@example.com/v1",
      "https://example.com/v1?key=value",
      "https://example.com/v1#fragment",
      "https://example.com/proxy-canary",
      "https://example.com/proxy-canary%2F",
    ]) {
      expect(() =>
        CredentialSource.parseOwner({
          providerId: "proxy",
          credentialId: "owner-proxy",
          rotationId: "rotation-1",
          sourceKind: "injected_runtime",
          auth: { type: "proxy", baseURL, apiKey: "proxy-canary" },
        }),
      ).toThrow(CredentialSourceError);
    }
  });

  it("derives correlation digests only from redacted metadata and rotation", () => {
    const registry = SecretRegistry.create(BoundarySanitizer.create());
    const first = registry.register(source("canary-one"));
    const changedSecret = registry.register(source("canary-two"));
    const rotated = registry.register(source("canary-two", "rotation-2"));

    expect(changedSecret.ref.credentialDigest).toBe(first.ref.credentialDigest);
    expect(rotated.ref.credentialDigest).not.toBe(first.ref.credentialDigest);
    expect(JSON.stringify(first.ref)).not.toContain("canary");
  });

  it("forbids serialization and exposes only redacted inspection", () => {
    const registry = SecretRegistry.create(BoundarySanitizer.create());
    const { handle } = registry.register(source("handle-canary"));
    expect(() => JSON.stringify(handle)).toThrow(SecretHandleSerializationError);
    expect(() => JSON.stringify(registry)).toThrow(SecretHandleSerializationError);
    expect(() => structuredClone(handle)).toThrow();
    expect(() => structuredClone(registry)).toThrow();
    expect(inspect(handle)).toBe("[SecretHandle]");
    expect(inspect(registry)).toBe("[SecretRegistry]");
  });

  it("redacts raw, JSON escaped, URL encoded, and common base64 forms", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    const secret = 'exact canary/"';
    const { handle } = registry.register(source(secret));
    const escaped = JSON.stringify(secret).slice(1, -1);
    const base64 = Buffer.from(secret).toString("base64");
    const base64url = base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    const cause = new Error(`cause ${secret}`);
    const error = new AggregateError(
      [new Error(`child ${base64}`)],
      `message ${encodeURIComponent(secret)}`,
      { cause },
    );
    error.stack = `stack ${escaped}`;

    const sanitized = sanitizer.sanitizeValue("telemetry", {
      text: `raw ${secret}`,
      escaped,
      encoded: encodeURIComponent(secret),
      base64,
      base64url,
      bytes: new TextEncoder().encode(`bytes ${secret}`),
      headers: new Headers({ authorization: `Bearer ${secret}` }),
      url: new URL(`https://example.com/${encodeURIComponent(secret)}`),
      error,
      handle,
    });
    const serialized = JSON.stringify(sanitized);
    for (const canary of [secret, escaped, encodeURIComponent(secret), base64, base64url])
      expect(serialized).not.toContain(canary);
    expect(serialized).toContain("[REDACTED]");
    expect(
      typeof sanitized === "object" && sanitized !== null && "handle" in sanitized
        ? sanitized.handle
        : undefined,
    ).toBe("[REDACTED:SECRET_HANDLE]");
    expect(sanitizer.sanitizeText("log", sanitizer.sanitizeText("log", secret))).toBe("[REDACTED]");
    expect(sanitizer.sanitizeError("error", error).message).not.toContain(secret);
  });

  it("redacts and rejects case-insensitive and partial percent encodings", () => {
    const secret = "Case /+";
    const lowercase = "Case%20%2f%2b";
    const mixed = "Case%20%2F%2b";
    const partial = "Case%20/%2B";
    const sanitizer = BoundarySanitizer.create();
    sanitizer.registerExactSecret(secret);

    for (const form of [lowercase, mixed, partial]) {
      expect(sanitizer.sanitizeText("log", `unrelated%2fvalue:${form}:end`)).toBe(
        "unrelated%2fvalue:[REDACTED]:end",
      );
      const sanitizedBytes = sanitizer.sanitizeValue("bytes", new TextEncoder().encode(form));
      expect(sanitizedBytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(sanitizedBytes as Uint8Array)).toBe("[REDACTED]");
      expect(() =>
        CredentialSource.parseOwner({
          providerId: "proxy",
          credentialId: "owner-proxy",
          rotationId: "rotation-1",
          sourceKind: "injected_runtime",
          auth: { type: "proxy", baseURL: `https://example.com/${form}`, apiKey: secret },
        }),
      ).toThrow(CredentialSourceError);
    }
  });

  it("derives byte forms without requiring decodable non-empty text", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    const binary = Uint8Array.from([0xff, 0x00, 0xfe]);
    const byteOrderMark = Uint8Array.from([0xef, 0xbb, 0xbf]);
    registry.register(source(binary));
    registry.register(source(byteOrderMark, "rotation-2"));

    expect(sanitizer.sanitizeText("log", "binary:/wD+:bom:77u/:end")).toBe(
      "binary:[REDACTED]:bom:[REDACTED]:end",
    );
    expect(sanitizer.sanitizeText("log", "encoded:%ff%00%Fe:end")).toBe("encoded:[REDACTED]:end");
    expect(() =>
      CredentialSource.parseOwner({
        providerId: "proxy",
        credentialId: "owner-proxy",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: {
          type: "proxy",
          baseURL: "https://example.com/77u%2F",
          apiKey: byteOrderMark,
        },
      }),
    ).toThrow(CredentialSourceError);
  });

  it("normalizes lone-surrogate secret handling to CredentialSourceError", () => {
    const secret = "lone-\ud800-surrogate";
    expect(() =>
      CredentialSource.parseOwner({
        providerId: "proxy",
        credentialId: "owner-proxy",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: {
          type: "proxy",
          baseURL: "https://example.com/v1",
          apiKey: secret,
        },
      }),
    ).toThrow(CredentialSourceError);

    const sanitizer = BoundarySanitizer.create();
    expect(() => sanitizer.registerExactSecret(secret)).not.toThrow();
    expect(sanitizer.sanitizeText("log", secret)).toBe("[REDACTED]");
  });

  it("redacts overlapping secrets longest-first in either registration order", () => {
    const short = "overlap-token";
    const long = `${short}-suffix`;
    const forms = (value: string) => {
      const base64 = Buffer.from(value).toString("base64");
      return [
        value,
        JSON.stringify(value).slice(1, -1),
        encodeURIComponent(value),
        base64,
        base64.replace(/=+$/u, ""),
        base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
      ];
    };

    for (const secrets of [
      [short, long],
      [long, short],
    ]) {
      const sanitizer = BoundarySanitizer.create();
      for (const secret of secrets) sanitizer.registerExactSecret(secret);
      for (const form of forms(long)) {
        expect(sanitizer.sanitizeText("text", `before:${form}:after`)).toBe(
          "before:[REDACTED]:after",
        );
        const sanitizedBytes = sanitizer.sanitizeValue(
          "bytes",
          new TextEncoder().encode(`before:${form}:after`),
        );
        expect(sanitizedBytes).toBeInstanceOf(Uint8Array);
        if (!(sanitizedBytes instanceof Uint8Array)) throw new Error("expected sanitized bytes");
        expect(new TextDecoder().decode(sanitizedBytes)).toBe("before:[REDACTED]:after");
      }
    }
  });

  it("fails closed after sanitizer or coordinated registry disposal", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    expect(SecretRegistry.isSanitizerPair(registry, sanitizer)).toBe(true);
    expect(() => SecretRegistry.create(sanitizer)).toThrow(
      expect.objectContaining({ code: "SANITIZER_ALREADY_CLAIMED" }),
    );
    const otherSanitizer = BoundarySanitizer.create();
    const otherRegistry = SecretRegistry.create(otherSanitizer);
    expect(SecretRegistry.isSanitizerPair(registry, otherSanitizer)).toBe(false);
    expect(SecretRegistry.isSanitizerPair(otherRegistry, sanitizer)).toBe(false);
    otherRegistry.dispose();
    registry.register(source("disposed-canary"));
    registry.dispose();
    expect(SecretRegistry.isSanitizerPair(registry, sanitizer)).toBe(false);

    for (const operation of [
      () => sanitizer.registerExactSecret("new-canary"),
      () => sanitizer.sanitizeText("log", "disposed-canary"),
      () => sanitizer.sanitizeValue("telemetry", { secret: "disposed-canary" }),
      () => sanitizer.sanitizeError("error", new Error("disposed-canary")),
    ])
      expect(operation).toThrow(BoundarySanitizerError);

    const independentlyDisposed = BoundarySanitizer.create();
    const secondRegistry = SecretRegistry.create(independentlyDisposed);
    expect(SecretRegistry.isSanitizerPair(secondRegistry, independentlyDisposed)).toBe(true);
    const parsed = source(new TextEncoder().encode("failed-register-canary"));
    const parsedBytes = parsed.auth.type === "api" ? parsed.auth.key : undefined;
    if (!(parsedBytes instanceof Uint8Array)) throw new Error("expected source bytes");
    independentlyDisposed.dispose();
    expect(SecretRegistry.isSanitizerPair(secondRegistry, independentlyDisposed)).toBe(false);
    expect(() => secondRegistry.register(parsed)).toThrow(BoundarySanitizerError);
    expect([...parsedBytes].every((byte) => byte === 0)).toBe(true);

    const disposedBytes = new TextEncoder().encode("disposed-register-canary");
    const disposedSource = source(disposedBytes);
    const disposedSourceBytes =
      disposedSource.auth.type === "api" ? disposedSource.auth.key : undefined;
    if (!(disposedSourceBytes instanceof Uint8Array)) throw new Error("expected source bytes");
    let disposedError: unknown;
    try {
      registry.register(disposedSource);
    } catch (error) {
      disposedError = error;
    }
    expect(disposedError).toBeInstanceOf(SecretRegistryError);
    expect((disposedError as SecretRegistryError).code).toBe("DISPOSED");
    expect([...disposedSourceBytes].every((byte) => byte === 0)).toBe(true);
  });

  it("contains hostile values with stable placeholders and bounded traversal", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    registry.register(source("hostile-canary"));
    let getterCalled = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "secret", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("hostile-canary");
      },
    });
    hostile.self = hostile;
    hostile.fn = () => "hostile-canary";
    hostile.symbol = Symbol("hostile-canary");
    hostile.unknown = Object.create({ hostile: true });
    let deep: Record<string, unknown> = hostile;
    for (let index = 0; index < 20; index += 1) deep = { child: deep };

    const first = sanitizer.sanitizeValue("boundary", deep);
    const second = sanitizer.sanitizeValue("boundary", deep);
    expect(getterCalled).toBe(false);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain("hostile-canary");
    expect(JSON.stringify(first)).toContain("[SANITIZED:MAX_DEPTH]");
  });

  it("uses inert records and stable placeholders for prototype keys, cycles, and proxies", () => {
    const sanitizer = BoundarySanitizer.create();
    sanitizer.registerExactSecret("prototype-canary");
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "__proto__", {
      value: "prototype-canary",
      enumerable: true,
    });
    Object.defineProperties(hostile, {
      constructor: { value: "prototype-canary", enumerable: true },
      prototype: { value: "prototype-canary", enumerable: true },
    });
    hostile.self = hostile;

    const sanitized = sanitizer.sanitizeValue("boundary", hostile);
    expect(typeof sanitized).toBe("object");
    expect(Object.getPrototypeOf(sanitized as object)).toBeNull();
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(true);
    expect(JSON.stringify(sanitized)).toContain("[SANITIZED:CIRCULAR]");
    expect(JSON.stringify(sanitized)).not.toContain("prototype-canary");

    const descriptorFailure = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("prototype-canary");
        },
      },
    );
    expect(sanitizer.sanitizeValue("boundary", descriptorFailure)).toBe(
      "[SANITIZED:SERIALIZATION_FAILURE]",
    );
  });

  it("bounds arrays, records, and Headers with explicit truncation markers", () => {
    const array = Array.from({ length: 1_005 }, (_, index) => `array-${index}`);
    const sanitizedArray = BoundarySanitizer.create().sanitizeValue("array", array);
    expect(Array.isArray(sanitizedArray)).toBe(true);
    expect((sanitizedArray as readonly SanitizedValue[]).length).toBe(1_000);
    expect((sanitizedArray as readonly SanitizedValue[]).at(-1)).toBe("[SANITIZED:TRUNCATED]");

    const record = Object.create(null) as Record<string, string>;
    const headers = new Headers();
    for (let index = 0; index < 1_005; index += 1) {
      const suffix = String(index).padStart(4, "0");
      record[`record-${suffix}`] = `value-${suffix}`;
      headers.set(`x-header-${suffix}`, `value-${suffix}`);
    }
    const sanitizedRecord = BoundarySanitizer.create().sanitizeValue("record", record);
    expect(Object.keys(sanitizedRecord as object)).toHaveLength(1_000);
    expect((sanitizedRecord as Record<string, SanitizedValue>)["[SANITIZED:TRUNCATED]"]).toBe(
      "[SANITIZED:TRUNCATED]",
    );

    const sanitizedHeaders = BoundarySanitizer.create().sanitizeValue("headers", headers);
    expect(Object.keys(sanitizedHeaders as object)).toHaveLength(1_000);
    expect((sanitizedHeaders as Record<string, SanitizedValue>)["[SANITIZED:TRUNCATED]"]).toBe(
      "[SANITIZED:TRUNCATED]",
    );
  });

  it("returns the recursive sanitized output contract rather than the input type", () => {
    const sanitizer = BoundarySanitizer.create();
    const output = sanitizer.sanitizeValue("boundary", { secret: "value" });
    const sanitized: SanitizedValue = output;
    expect(typeof sanitized).toBe("object");
    if (typeof sanitized !== "object" || sanitized === null || !("secret" in sanitized))
      throw new Error("expected sanitized record");
    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(sanitized.secret).toBe("value");
    // @ts-expect-error Sanitization can replace the input shape with placeholders.
    const falselyTyped: { secret: string } = output;
    void falselyTyped;
  });

  it("copies custody buffers and scrubs source, materialized, and retained buffers", async () => {
    const sourceBytes = new TextEncoder().encode("material-canary");
    const parsed = source(sourceBytes);
    sourceBytes.fill(7);
    const parsedBytes = parsed.auth.type === "api" ? parsed.auth.key : undefined;
    if (!(parsedBytes instanceof Uint8Array)) throw new Error("expected parsed credential buffer");
    const registry = SecretRegistry.create(BoundarySanitizer.create());
    const { handle } = registry.register(parsed);
    expect([...parsedBytes].every((byte) => byte === 0)).toBe(true);

    let exposed: Uint8Array | undefined;
    await registry.withMaterialized(handle, "openai", (credential) => {
      expect(credential.providerId).toBe("openai");
      if (credential.authType !== "api") throw new Error("expected api credential");
      exposed = credential.key;
      expect(new TextDecoder().decode(exposed)).toBe("material-canary");
    });
    if (exposed === undefined) throw new Error("expected exposed credential buffer");
    expect([...exposed].every((byte) => byte === 0)).toBe(true);
    await expect(
      registry.withMaterialized(handle, "anthropic", () => undefined),
    ).rejects.toBeInstanceOf(SecretRegistryError);
    registry.dispose();
    registry.dispose();
    await expect(
      registry.withMaterialized(handle, "openai", () => undefined),
    ).rejects.toMatchObject({ code: "DISPOSED" });
  });
  it("authenticates handle suppression by registry identity rather than marker-shaped objects", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    const { handle } = registry.register(source("identity-canary"));
    const marker = Symbol("openomni.secret-handle");
    const forged = { [marker]: true, visible: "not-a-secret-handle" };

    expect(sanitizer.sanitizeValue("boundary", handle)).toBe("[REDACTED:SECRET_HANDLE]");
    const sanitizedForged = sanitizer.sanitizeValue("boundary", forged);
    expect(JSON.stringify(sanitizedForged)).toContain("not-a-secret-handle");

    let proxyTrapCalls = 0;
    const hostileProxy = new Proxy(handle, {
      get() {
        proxyTrapCalls += 1;
        throw new Error("proxy get trap executed");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("proxy prototype trap executed");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("proxy ownKeys trap executed");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("proxy descriptor trap executed");
      },
    });
    expect(sanitizer.sanitizeValue("boundary", hostileProxy)).toBe(
      "[SANITIZED:SERIALIZATION_FAILURE]",
    );
    expect(proxyTrapCalls).toBe(0);
  });

  it("caps oversized own-key traversal with a stable truncation sentinel", () => {
    const keys = Array.from({ length: 1_005 }, (_, index) => `key-${index}`);
    const oversized = Object.fromEntries(keys.map((key) => [key, "value"]));
    const sanitizer = BoundarySanitizer.create();
    const first = sanitizer.sanitizeValue("boundary", oversized);
    const second = sanitizer.sanitizeValue("boundary", oversized);
    expect(Object.keys(first as object)).toHaveLength(1_000);
    expect((first as Record<string, SanitizedValue>)["[SANITIZED:TRUNCATED]"]).toBe(
      "[SANITIZED:TRUNCATED]",
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const sparse: unknown[] = [];
    sparse.length = 1_000_000;
    sparse[999_999] = "unreachable";
    const sanitizedSparse = BoundarySanitizer.create().sanitizeValue("boundary", sparse);
    expect((sanitizedSparse as readonly SanitizedValue[]).length).toBe(1_000);
    expect((sanitizedSparse as readonly SanitizedValue[]).at(-1)).toBe("[SANITIZED:TRUNCATED]");
  });

  it("materializes proxy credentials with optional keys and zeroes buffers on resolve and reject", async () => {
    for (const secret of ["proxy-material-canary", undefined] as const) {
      const sanitizer = BoundarySanitizer.create();
      const registry = SecretRegistry.create(sanitizer);
      const parsed = CredentialSource.parseOwner({
        providerId: "proxy",
        credentialId: "owner-proxy",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: {
          type: "proxy",
          baseURL: "https://proxy.invalid/v1",
          ...(secret === undefined ? {} : { apiKey: secret }),
        },
      });
      const { handle } = registry.register(parsed);
      let resolvedBuffer: Uint8Array | undefined;
      await registry.withMaterialized(handle, "proxy", (credential) => {
        if (credential.authType !== "proxy") throw new Error("expected proxy credential");
        resolvedBuffer = credential.apiKey;
        expect(credential.baseURL).toBe("https://proxy.invalid/v1");
      });
      if (secret === undefined) {
        expect(resolvedBuffer).toBeUndefined();
      } else {
        if (resolvedBuffer === undefined) throw new Error("expected resolved credential buffer");
        expect([...resolvedBuffer].every((byte) => byte === 0)).toBe(true);
      }

      let rejectedBuffer: Uint8Array | undefined;
      await expect(
        registry.withMaterialized(handle, "proxy", (credential) => {
          if (credential.authType !== "proxy") throw new Error("expected proxy credential");
          rejectedBuffer = credential.apiKey;
          throw new Error("provider rejected");
        }),
      ).rejects.toThrow("provider rejected");
      if (secret === undefined) {
        expect(rejectedBuffer).toBeUndefined();
      } else {
        if (rejectedBuffer === undefined) throw new Error("expected rejected credential buffer");
        expect([...rejectedBuffer].every((byte) => byte === 0)).toBe(true);
      }
    }
  });
  it("sanitizes connector text and errors through the paired registry boundary", () => {
    const sanitizer = BoundarySanitizer.create();
    const registry = SecretRegistry.create(sanitizer);
    const secret = "connector-boundary-canary";
    registry.register(
      CredentialSource.parseOwner({
        providerId: "connector-provider",
        credentialId: "CONNECTOR_API_KEY",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: { type: "api", key: secret },
      }),
    );
    const encoded = Buffer.from(secret).toString("base64");

    expect(registry.sanitizeText("connector.stdout", `result:${encoded}`)).toBe(
      "result:[REDACTED]",
    );
    expect(registry.sanitizeError("connector.error", new Error(`failed:${secret}`)).message).toBe(
      "failed:[REDACTED]",
    );
    const nested = registry.sanitizeValue("connector.result", {
      error: new Error("outer", { cause: new Error(`nested:${encoded}`) }),
    });
    expect(JSON.stringify(nested)).not.toContain(encoded);
    const nestedError = Reflect.get(nested as object, "error");
    expect(nestedError).toBeInstanceOf(Error);
    const nestedCause = (nestedError as Error).cause;
    expect(nestedCause).toBeInstanceOf(Error);
    expect((nestedCause as Error).message).toContain("[REDACTED]");
  });
});
