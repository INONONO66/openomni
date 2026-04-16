import { afterEach, describe, expect, it } from "bun:test";
import { Auth, Provider } from "@openomni/llm";
import {
  resolveCatalogModel,
  resolveDefaultProviderModel,
  resolveRuntimeModel,
} from "../src/agents/model-resolution";

function makeModel(
  id: string,
  name: string,
  releaseDate: string,
  family = "claude-sonnet",
): Provider.Model {
  return {
    id,
    providerID: "anthropic",
    name,
    family,
    release_date: releaseDate,
    status: "active",
  };
}

const originalAuthAll = Auth.all;
const originalAuthGet = Auth.get;
const originalListModels = Provider.listModels;

afterEach(() => {
  Auth.all = originalAuthAll;
  Auth.get = originalAuthGet;
  Provider.listModels = originalListModels;
});

describe("resolveCatalogModel", () => {
  it("maps exact latest aliases to concrete dated model IDs", () => {
    const models = [
      makeModel("claude-sonnet-4-5", "Claude Sonnet 4.5 (latest)", "2025-09-29"),
      makeModel("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29"),
    ];

    expect(resolveCatalogModel("claude-sonnet-4-5", models)?.id).toBe("claude-sonnet-4-5-20250929");
  });

  it("resolves version aliases by concrete prefix match when the alias entry is absent", () => {
    const models = [
      makeModel("claude-opus-4-5-20251101", "Claude Opus 4.5", "2025-11-01", "claude-opus"),
    ];

    expect(resolveCatalogModel("claude-opus-4-5", models)?.id).toBe("claude-opus-4-5-20251101");
  });

  it("falls back to the newest concrete model in the same family for newer aliases", () => {
    const models = [
      makeModel("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29"),
      makeModel("claude-sonnet-4-20250514", "Claude Sonnet 4", "2025-05-22"),
    ];

    expect(resolveCatalogModel("claude-sonnet-4-6", models)?.id).toBe("claude-sonnet-4-5-20250929");
  });
});

describe("resolveRuntimeModel", () => {
  it("resolves runtime agent models through the provider catalog", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [
      makeModel("claude-sonnet-4-5", "Claude Sonnet 4.5 (latest)", "2025-09-29"),
      makeModel("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29"),
    ];

    await expect(
      resolveRuntimeModel({ provider: "anthropic", id: "claude-sonnet-4-5" }),
    ).resolves.toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
    });
  });

  it("falls back to the server default model for the same provider when lookup misses", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [];

    await expect(
      resolveRuntimeModel(
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "anthropic", id: "claude-opus-4-20250514" },
      ),
    ).resolves.toEqual({
      provider: "anthropic",
      id: "claude-opus-4-20250514",
    });
  });
});

describe("resolveDefaultProviderModel", () => {
  it("converts the bootstrap default model to a concrete dated ID", async () => {
    Auth.all = async () => ({
      anthropic: { type: "api", key: "test-key" },
    });
    Provider.listModels = async () => [
      makeModel("claude-sonnet-4-5", "Claude Sonnet 4.5 (latest)", "2025-09-29"),
      makeModel("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29"),
    ];

    await expect(resolveDefaultProviderModel()).resolves.toMatchObject({
      providerID: "anthropic",
      id: "claude-sonnet-4-5-20250929",
    });
  });
});
