import { Model } from "@openomni/protocol";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

const catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: { "gpt-test": { id: "gpt-test", name: "GPT Test" } },
  },
};

describe("ModelsDev", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openomni-models-service-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe("schemas", () => {
    it("validates model and provider catalog records", () => {
      expect(
        ModelsDev.Model.safeParse({
          id: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          cost: { input: 3, output: 15 },
          limit: { context: 200000, output: 8192 },
          modalities: { input: ["text", "image"], output: ["text"] },
          status: "active",
          interleaved: { field: "reasoning_content" },
        }).success,
      ).toBe(true);
      expect(ModelsDev.Model.safeParse({ name: "missing id" }).success).toBe(false);
      expect(ModelsDev.Provider.safeParse(catalog.openai).success).toBe(true);
      expect(ModelsDev.ModelStatus).toBe(Model.Status);
    });
  });

  it("creates an explicit catalog service from caller-owned options", async () => {
    const fetchRemote = mock(async ({ timeoutMs }: { timeoutMs: 10_000 }) => {
      expect(timeoutMs).toBe(10_000);
      return { catalog, version: "test-catalog-v1" };
    });
    const service = ModelsDev.createService({
      cachePath: join(directory, "models.json"),
      environment,
      remoteURL: "https://models.test/catalog.json",
      dependencies: { fetchRemote },
    });

    const loaded = await service.load();

    expect(loaded.catalog.openai?.models["gpt-test"]).toEqual({
      id: "gpt-test",
      name: "GPT Test",
    });
    expect(loaded.environment.catalogSource).toBe("remote");
    expect(loaded.environment.catalogSourceVersion).toBe("test-catalog-v1");
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent reads within one explicit service without a global data cache", async () => {
    const fetchRemote = mock(async () => ({ catalog, version: "test-catalog-v1" }));
    const service = ModelsDev.createService({
      cachePath: join(directory, "models.json"),
      environment,
      remoteURL: "https://models.test/catalog.json",
      dependencies: { fetchRemote },
    });

    const [first, second] = await Promise.all([service.get(), service.get()]);

    expect(first).toEqual(second);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect("Data" in ModelsDev).toBe(false);
    expect("get" in ModelsDev).toBe(false);
    expect("refresh" in ModelsDev).toBe(false);
  });
});
