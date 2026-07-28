import { describe, expect, test } from "bun:test";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { composeP2Runtime } from "../../src/bootstrap/p2-runtime";

const digest = "a".repeat(64);
const semanticServices = Object.freeze({
  messaging: Object.freeze({ dispatch: () => undefined }),
});

function bootstrap(canary = "p2-bootstrap-secret") {
  const sanitizer = BoundarySanitizer.create();
  const secrets = SecretRegistry.create(sanitizer);
  const { ref: credential } = secrets.register(
    CredentialSource.parseOwner({
      providerId: "openai",
      credentialId: "owner-default",
      rotationId: "rotation-1",
      sourceKind: "default_file",
      sourcePath: "/owner/credentials.json",
      auth: { type: "api", key: canary },
    }),
  );
  const bootstrapSnapshot = {
    version: "p2-redacted-bootstrap-snapshot-v1" as const,
    credentialRefs: [credential],
  };
  const modelEnvironment = {
    version: "llm-environment-v1" as const,
    catalogSchemaVersion: 1,
    catalogSource: "bundled" as const,
    catalogSourceVersion: "2026-07-25",
    catalogDigest: digest,
    modelDigest: digest,
    endpoint: {
      version: "llm-endpoint-ref-v1" as const,
      kind: "default" as const,
      valueRef: "provider-default",
      endpointDigest: digest,
    },
    credential,
    sdkPackage: "@ai-sdk/openai",
    adapterVersion: "1",
    environmentDigest: digest,
  };
  return {
    sanitizer,
    secrets,
    services: semanticServices,
    bootstrapSnapshot,
    modelEnvironment,
  };
}

function ports(onCall: () => void) {
  const unexpected = async (): Promise<never> => {
    onCall();
    throw new Error("composition invoked a runtime port");
  };
  return {
    queries: { query: unexpected },
  };
}

describe("dormant P2 server composition", () => {
  test("composes only explicit ports and already-loaded credential state without ambient effects", () => {
    let calls = 0;
    const explicitPorts = ports(() => {
      calls += 1;
    });
    const loaded = bootstrap();

    const runtime = composeP2Runtime({ ...explicitPorts, ...loaded });

    expect(calls).toBe(0);
    expect(runtime.queries).toBe(explicitPorts.queries);
    expect(runtime.services).toBe(loaded.services);
    expect(runtime.sanitizer).toBe(loaded.sanitizer);
    expect(runtime.secrets).toBe(loaded.secrets);
    expect(runtime.bootstrapSnapshot).toEqual(loaded.bootstrapSnapshot);
    expect(runtime.modelEnvironment).toEqual(loaded.modelEnvironment);
    expect("credentialSources" in runtime).toBe(false);
    expect("append" in runtime).toBe(false);
    expect("writer" in runtime).toBe(false);
    expect("transitions" in runtime).toBe(false);
    expect("close" in runtime).toBe(false);
  });

  test("rejects a registry composed with a different sanitizer", () => {
    const explicitPorts = ports(() => undefined);
    const first = bootstrap("first-composition-secret");
    const second = bootstrap("second-composition-secret");
    try {
      expect(() =>
        composeP2Runtime({
          ...explicitPorts,
          ...first,
          sanitizer: second.sanitizer,
        }),
      ).toThrow("Invalid SecretRegistry and BoundarySanitizer pair");
    } finally {
      first.secrets.dispose();
      second.secrets.dispose();
    }
  });

  test("rejects snapshot version substitution instead of normalizing it", () => {
    const explicitPorts = ports(() => undefined);
    const loaded = bootstrap();
    const bootstrapSnapshot = {
      ...loaded.bootstrapSnapshot,
      version: "p2-redacted-bootstrap-snapshot-v2",
    };

    expect(() =>
      composeP2Runtime({
        ...explicitPorts,
        ...loaded,
        bootstrapSnapshot: bootstrapSnapshot as typeof loaded.bootstrapSnapshot,
      }),
    ).toThrow("Unsupported P2 redacted bootstrap snapshot version");
  });

  test("deep-clones and freezes nested endpoint and credential references", () => {
    const explicitPorts = ports(() => undefined);
    const loaded = bootstrap();
    const endpoint = loaded.modelEnvironment.endpoint;
    const credential = loaded.modelEnvironment.credential;
    const runtime = composeP2Runtime({ ...explicitPorts, ...loaded });

    expect(runtime.modelEnvironment.endpoint).not.toBe(endpoint);
    expect(runtime.modelEnvironment.credential).not.toBe(credential);
    expect(Object.isFrozen(runtime.modelEnvironment.endpoint)).toBe(true);
    expect(Object.isFrozen(runtime.modelEnvironment.credential)).toBe(true);
    endpoint.valueRef = "mutated-endpoint";
    expect(() => {
      runtime.modelEnvironment.endpoint.valueRef = "runtime-mutation";
    }).toThrow();
    expect(() => {
      runtime.modelEnvironment.credential.rotationId = "runtime-mutation";
    }).toThrow();
    expect(runtime.modelEnvironment.endpoint.valueRef).toBe("provider-default");
    expect(runtime.modelEnvironment.credential.rotationId).toBe("rotation-1");
  });

  test("redacted bootstrap serialization contains no credential canary", () => {
    const canary = "p2-ordinary-bootstrap-secret-canary";
    const explicitPorts = ports(() => undefined);
    const loaded = bootstrap(canary);
    const runtime = composeP2Runtime({ ...explicitPorts, ...loaded });

    const serialized = JSON.stringify({
      bootstrapSnapshot: runtime.bootstrapSnapshot,
      modelEnvironment: runtime.modelEnvironment,
    });
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("credentials");
    expect(serialized).toContain("credentialRefs");
  });

  test("fails closed on an unvalidated model environment", () => {
    const explicitPorts = ports(() => undefined);
    const loaded = bootstrap();

    expect(() =>
      composeP2Runtime({
        ...explicitPorts,
        ...loaded,
        modelEnvironment: { ...loaded.modelEnvironment, catalogDigest: "not-a-digest" },
      }),
    ).toThrow();
  });
});
