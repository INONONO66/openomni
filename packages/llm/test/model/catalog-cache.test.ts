import { Execution } from "@openomni/protocol";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsDev } from "../../src/model";
import {
  CATALOG_CACHE_FILE_MODE,
  CATALOG_CACHE_SCHEMA,
  CATALOG_CACHE_SCHEMA_VERSION,
} from "../../src/model/catalog-cache";

function environment(rotationId = "rotation-1") {
  return {
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
      rotationId,
      sourceKind: "default_file" as const,
      sourcePathDigest: "d".repeat(64),
      credentialDigest: rotationId === "rotation-1" ? "e".repeat(64) : "f".repeat(64),
    },
    sdkPackage: "@ai-sdk/openai",
    adapterVersion: "1",
  };
}

const remoteCatalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://untrusted.example/v1",
    models: {
      gpt: {
        id: "gpt-api-id",
        name: "GPT",
        provider: { npm: "@ai-sdk/anthropic" },
        options: { safe: true, url: "https://untrusted.example/model" },
      },
    },
  },
};

describe("derived model catalog cache", () => {
  let directory: string;
  let cachePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openomni-derived-catalog-"));
    cachePath = join(directory, "models.json");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createService(
    binding: ReturnType<typeof environment>,
    fetchRemote: () => Promise<{ catalog: unknown; version: string }>,
  ) {
    return ModelsDev.createService({
      cachePath,
      environment: binding,
      remoteURL: "https://models.test/catalog.json",
      dependencies: { fetchRemote, tempName: () => "test" },
    });
  }

  it("writes a versioned, restricted, sanitized cache envelope", async () => {
    const loaded = await createService(environment(), async () => ({
      catalog: remoteCatalog,
      version: "remote-v1",
    })).load();
    const persisted = JSON.parse(await readFile(cachePath, "utf8"));

    expect(persisted).toEqual({
      schema: CATALOG_CACHE_SCHEMA,
      schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
      fetchedAt: expect.any(Number),
      catalogSource: "remote",
      catalogVersion: "remote-v1",
      digest: loaded.environment.catalogDigest,
      catalog: loaded.catalog,
    });
    expect(JSON.stringify(persisted)).not.toContain("untrusted.example");
    expect(JSON.stringify(persisted)).not.toContain('"provider"');
    expect((await stat(cachePath)).mode & 0o777).toBe(CATALOG_CACHE_FILE_MODE);
    expect(Execution.LLMEnvironmentV1.parse(loaded.environment)).toEqual(loaded.environment);
  });

  it("treats a fresh cache as derived data, never as authority for caller bindings", async () => {
    const first = await createService(environment("rotation-1"), async () => ({
      catalog: remoteCatalog,
      version: "remote-v1",
    })).load();
    const fetchRemote = mock(async () => {
      throw new Error("a fresh cache should not fetch");
    });

    const second = await createService(environment("rotation-2"), fetchRemote).load();

    expect(second.catalog).toEqual(first.catalog);
    expect(second.environment.catalogDigest).toBe(first.environment.catalogDigest);
    expect(second.environment.credential.rotationId).toBe("rotation-2");
    expect(second.environment.credential.credentialDigest).toBe("f".repeat(64));
    expect(second.environment.environmentDigest).not.toBe(first.environment.environmentDigest);
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it("rejects a tampered derived cache and regenerates it from the explicit source", async () => {
    await createService(environment(), async () => ({
      catalog: remoteCatalog,
      version: "remote-v1",
    })).load();
    const envelope = JSON.parse(await readFile(cachePath, "utf8"));
    envelope.digest = "0".repeat(64);
    await writeFile(cachePath, JSON.stringify(envelope), "utf8");
    const fetchRemote = mock(async () => ({ catalog: remoteCatalog, version: "regenerated" }));

    const loaded = await createService(environment(), fetchRemote).load();

    expect(loaded.environment.catalogSourceVersion).toBe("regenerated");
    expect(loaded.fallbackDiagnostics).toEqual([
      {
        stage: "cache-validation",
        cause: {
          name: "CatalogValidationFailure",
          message: "The model catalog cache failed validation",
        },
      },
    ]);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it("keeps validated remote data usable when derived-cache persistence fails", async () => {
    const nativeService = createService(environment(), async () => ({
      catalog: remoteCatalog,
      version: "remote-v1",
    }));
    const native = await nativeService.load();
    await rm(cachePath, { force: true });
    const fs = {
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      mkdir: async () => undefined,
      open: async () => {
        throw new Error("disk unavailable");
      },
      chmod: async () => undefined,
      rename: async () => undefined,
      unlink: async () => undefined,
    };
    const service = ModelsDev.createService({
      cachePath,
      environment: environment(),
      remoteURL: "https://models.test/catalog.json",
      dependencies: {
        fs,
        fetchRemote: async () => ({ catalog: remoteCatalog, version: "remote-v1" }),
      },
    });

    const loaded = await service.load();

    expect(loaded.catalog).toEqual(native.catalog);
    expect(loaded.environment.catalogSource).toBe("remote");
    expect(loaded.cacheWriteError?.name).toBe("CatalogCacheWriteError");
  });
});
