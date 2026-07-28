import { afterEach, describe, expect, it } from "bun:test";
import { Auth, Provider } from "@openomni/llm";
import { resolveDefaultProviderModel, resolveRuntimeModel } from "../src/agents/model-resolution";

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

describe("resolveRuntimeModel", () => {
  it("maps exact latest aliases to concrete dated model IDs", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [
      makeModel("claude-sonnet-4-5", "Claude Sonnet 4.5 (latest)", "2025-09-29"),
      makeModel("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29"),
    ];

    const resolved = await resolveRuntimeModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(resolved).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5-20250929",
    });
  });

  it("resolves version aliases by concrete prefix match when the alias entry is absent", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [
      makeModel("claude-opus-4-5-20251101", "Claude Opus 4.5", "2025-11-01", "claude-opus"),
    ];

    const resolved = await resolveRuntimeModel({ provider: "anthropic", id: "claude-opus-4-5" });
    expect(resolved).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-5-20251101",
    });
  });

  it("passes the requested model through when the requested model has no exact or prefix match", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [
      makeModel("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "2025-09-29"),
      makeModel("claude-sonnet-4-20250514", "Claude Sonnet 4", "2025-05-22"),
    ];

    const resolved = await resolveRuntimeModel({ provider: "anthropic", id: "claude-sonnet-4-6" });
    expect(resolved).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" });
  });

  it("falls back to the server default model for the same provider when lookup misses", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [];

    const resolved = await resolveRuntimeModel(
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-20250514" },
    );
    expect(resolved).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-20250514",
    });
  });

  it("passes the requested model through when the catalog misses and no default is provided", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => [];

    const resolved = await resolveRuntimeModel({ provider: "anthropic", id: "claude-sonnet-4-6" });
    expect(resolved).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" });
  });

  it("warns with the underlying catalog error and falls back to the default model when listModels throws", async () => {
    Auth.get = async () => ({ type: "api", key: "test-key" });
    Provider.listModels = async () => {
      throw new Error("network down");
    };

    const resolved = await resolveRuntimeModel(
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "anthropic", id: "claude-opus-4-20250514" },
    );
    expect(resolved).toEqual({
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

    const resolved = await resolveDefaultProviderModel();
    expect(resolved).toMatchObject({
      providerID: "anthropic",
      id: "claude-sonnet-4-5-20250929",
    });
  });
});
