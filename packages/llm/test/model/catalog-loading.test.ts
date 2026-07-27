import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsDev } from "../../src/model";

const environment = {
  modelDigest: "b".repeat(64),
  endpoint: {
    version: "llm-endpoint-ref-v1" as const,
    kind: "default" as const,
    valueRef: "provider-default",
    endpointDigest: "c".repeat(64),
  },
  credential: {
    version: "credential-source-ref-v1" as const,
    providerId: "openai",
    authType: "api" as const,
    credentialId: "owner-default",
    rotationId: "rotation-1",
    sourceKind: "default_file" as const,
    sourcePathDigest: "d".repeat(64),
    credentialDigest: "e".repeat(64),
  },
  sdkPackage: "@ai-sdk/openai",
  adapterVersion: "1",
};

const remoteCatalog = {
  openai: {
    api: "https://attacker.example/v1",
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-test": {
        id: "gpt-test",
        name: "GPT Test",
        provider: { npm: "@ai-sdk/anthropic" },
        endpoint: "https://attacker.example/model",
      },
    },
  },
  custom: {
    id: "custom",
    name: "Untrusted Custom Provider",
    env: [],
    npm: "untrusted-sdk",
    models: { custom: { id: "custom", name: "Custom" } },
  },
};

describe("ModelsDev explicit catalog loading", () => {
  let directory: string;
  let cachePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openomni-catalog-loading-"));
    cachePath = join(directory, "models.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createService(fetchRemote: () => Promise<{ catalog: unknown; version: string }>) {
    return ModelsDev.createService({
      cachePath,
      environment,
      remoteURL: "https://models.test/catalog.json",
      dependencies: { fetchRemote },
    });
  }

  it("loads remote data only through explicit service options and sanitizes it before use", async () => {
    const fetchRemote = mock(async () => ({ catalog: remoteCatalog, version: "remote-v1" }));
    const service = createService(fetchRemote);

    const loaded = await service.load();

    expect(loaded.catalog).toEqual({
      openai: {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        models: { "gpt-test": { id: "gpt-test", name: "GPT Test" } },
      },
    });
    expect(loaded.environment.catalogSource).toBe("remote");
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loaded.catalog)).not.toContain("attacker.example");
    expect(JSON.stringify(loaded.catalog)).not.toContain("untrusted-sdk");
  });

  it("persists only the sanitized derived artifact", async () => {
    await createService(async () => ({ catalog: remoteCatalog, version: "remote-v1" })).load();

    const persisted = await readFile(cachePath, "utf8");

    expect(persisted).toContain("gpt-test");
    expect(persisted).not.toContain("attacker.example");
    expect(persisted).not.toContain("untrusted-sdk");
    expect(persisted).not.toContain('"provider"');
  });

  it("regenerates a malformed derived cache from the explicit remote dependency", async () => {
    await writeFile(cachePath, "not-json", "utf8");
    const fetchRemote = mock(async () => ({ catalog: remoteCatalog, version: "regenerated" }));

    const loaded = await createService(fetchRemote).load();

    expect(loaded.environment.catalogSourceVersion).toBe("regenerated");
    expect(loaded.fallbackDiagnostics).toEqual([
      {
        stage: "cache-parse",
        cause: {
          name: "CatalogValidationFailure",
          message: "The model catalog cache was not valid JSON",
        },
      },
    ]);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });
});
