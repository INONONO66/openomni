import { afterEach, describe, expect, it } from "bun:test";
import type { ModelCatalogService } from "@openomni/llm";
import {
  BoundarySanitizer,
  CredentialSource,
  SecretRegistry,
} from "@openomni/llm/credential-runtime";
import { Execution } from "@openomni/protocol";
import { resolveRuntimeModel } from "../src/agents/model-resolution";

const CATALOG_DIGEST = "a".repeat(64);
const MODEL_DIGEST = "b".repeat(64);
const ENDPOINT_DIGEST = "c".repeat(64);
const ENVIRONMENT_DIGEST = "d".repeat(64);

const catalog = Object.freeze({
  anthropic: Object.freeze({
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic" as const,
    models: Object.freeze({
      "claude-sonnet-4-5": Object.freeze({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5 (latest)",
        family: "claude-sonnet",
        release_date: "2025-09-29",
      }),
      "claude-sonnet-4-5-20250929": Object.freeze({
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        family: "claude-sonnet",
        release_date: "2025-09-29",
      }),
      "claude-opus-4-20250514": Object.freeze({
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        family: "claude-opus",
        release_date: "2025-05-14",
      }),
    }),
  }),
  openai: Object.freeze({
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai" as const,
    models: Object.freeze({
      "claude-sonnet-4-5-20250929": Object.freeze({
        id: "claude-sonnet-4-5-20250929",
        name: "Provider-local collision",
      }),
    }),
  }),
});

const registries: SecretRegistry[] = [];

afterEach(() => {
  for (const registry of registries) registry.dispose();
  registries.length = 0;
});

function registerCredential(providerId = "anthropic", credentialId = `${providerId}-owner`) {
  const registry = SecretRegistry.create(BoundarySanitizer.create());
  registries.push(registry);
  const registered = registry.register(
    CredentialSource.parseOwner({
      providerId,
      credentialId,
      rotationId: "rotation-1",
      sourceKind: "injected_runtime",
      auth: { type: "api", key: "test-api-key" },
    }),
  );
  return { registry, ...registered };
}

function makeEnvironment(
  credential: Execution.CredentialSourceRefV1,
  environmentDigest = ENVIRONMENT_DIGEST,
): Execution.LLMEnvironmentV1 {
  return Execution.LLMEnvironmentV1.parse({
    version: "llm-environment-v1",
    catalogSchemaVersion: 1,
    catalogSource: "bundled",
    catalogSourceVersion: "test-catalog",
    catalogDigest: CATALOG_DIGEST,
    modelDigest: MODEL_DIGEST,
    endpoint: {
      version: "llm-endpoint-ref-v1",
      kind: "default",
      valueRef: "anthropic-default",
      endpointDigest: ENDPOINT_DIGEST,
    },
    credential,
    sdkPackage: "@ai-sdk/anthropic",
    adapterVersion: "test-adapter",
    environmentDigest,
  });
}

function makeCatalog(
  environment: Execution.LLMEnvironmentV1,
  loadedEnvironment = environment,
  catalogValue: Awaited<ReturnType<ModelCatalogService["get"]>> = catalog,
): ModelCatalogService {
  return Object.freeze({
    load: async () =>
      Object.freeze({
        catalog: catalogValue,
        environment: loadedEnvironment,
        fallbackDiagnostics: Object.freeze([]),
      }),
    get: async () => catalogValue,
  });
}

async function resolve(model: { readonly provider: string; readonly id: string }) {
  const registered = registerCredential();
  const environment = makeEnvironment(registered.ref);
  return resolveRuntimeModel({
    model,
    modelCatalog: makeCatalog(environment),
    secretRegistry: registered.registry,
    credentialHandle: registered.handle,
    modelEnvironment: environment,
  });
}

describe("resolveRuntimeModel", () => {
  it("resolves the exact provider and concrete model with injected provenance", async () => {
    const registered = registerCredential();
    const environment = makeEnvironment(registered.ref);

    const resolved = await resolveRuntimeModel({
      model: { provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
      modelCatalog: makeCatalog(environment),
      secretRegistry: registered.registry,
      credentialHandle: registered.handle,
      modelEnvironment: environment,
    });

    expect(resolved.model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
    });
    expect(resolved.environment).toEqual(environment);
    expect(resolved.credentialHandle).toBe(registered.handle);
  });

  it("resolves an alias only within the explicitly requested provider", async () => {
    const resolved = await resolve({ provider: "anthropic", id: "claude-sonnet-4-5" });

    expect(resolved.model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
    });
  });

  it("keeps an exact configured model when the production catalog pins that entry", async () => {
    const registered = registerCredential();
    const environment = makeEnvironment(registered.ref);
    const configuredModel = catalog.anthropic.models["claude-sonnet-4-5"];
    const pinnedCatalog = Object.freeze({
      anthropic: Object.freeze({
        ...catalog.anthropic,
        models: Object.freeze({ "claude-sonnet-4-5": configuredModel }),
      }),
    });

    await expect(
      resolveRuntimeModel({
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        modelCatalog: makeCatalog(environment, environment, pinnedCatalog),
        secretRegistry: registered.registry,
        credentialHandle: registered.handle,
        modelEnvironment: environment,
      }),
    ).resolves.toMatchObject({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      environment,
    });
  });

  it("fails when the requested model is missing instead of selecting another catalog model", async () => {
    await expect(resolve({ provider: "anthropic", id: "claude-sonnet-4-6" })).rejects.toThrow(
      "Model not found in provider catalog: anthropic/claude-sonnet-4-6",
    );
  });

  it("fails when the credential handle is absent from the injected registry", async () => {
    const owner = registerCredential();
    const other = registerCredential();
    const environment = makeEnvironment(owner.ref);

    await expect(
      resolveRuntimeModel({
        model: { provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
        modelCatalog: makeCatalog(environment),
        secretRegistry: other.registry,
        credentialHandle: owner.handle,
        modelEnvironment: environment,
      }),
    ).rejects.toThrow("unknown SecretRegistry handle");
  });

  it("rejects a credential whose provenance does not match the LLM environment", async () => {
    const selected = registerCredential("anthropic", "selected-credential");
    const environmentCredential = registerCredential("anthropic", "environment-credential");
    const environment = makeEnvironment(environmentCredential.ref);

    await expect(
      resolveRuntimeModel({
        model: { provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
        modelCatalog: makeCatalog(environment),
        secretRegistry: selected.registry,
        credentialHandle: selected.handle,
        modelEnvironment: environment,
      }),
    ).rejects.toThrow("Credential binding does not match model provider anthropic");
  });

  it("rejects a catalog whose provenance does not match the LLM environment", async () => {
    const registered = registerCredential();
    const environment = makeEnvironment(registered.ref);
    const catalogEnvironment = makeEnvironment(registered.ref, "e".repeat(64));

    await expect(
      resolveRuntimeModel({
        model: { provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
        modelCatalog: makeCatalog(environment, catalogEnvironment),
        secretRegistry: registered.registry,
        credentialHandle: registered.handle,
        modelEnvironment: environment,
      }),
    ).rejects.toThrow("Model catalog environment does not match the injected LLM environment");
  });
});
