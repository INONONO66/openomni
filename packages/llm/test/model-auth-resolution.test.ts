import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Auth, ModelsDev, Provider } from "../src";

const catalog = {
  anthropic: {
    id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: [],
    models: { trusted: { id: "trusted", name: "Trusted", limit: { context: 1000 } } },
  },
};

afterEach(() => mock.restore());

describe("canonical model and provider-bound credentials", () => {
  test("trusted catalog identity is exact and needs no discovery I/O", async () => {
    const catalogRead = spyOn(ModelsDev, "get").mockResolvedValue(catalog);
    const authRead = spyOn(Auth, "get").mockResolvedValue(undefined);
    const fetch = spyOn(globalThis, "fetch");
    expect(await Provider.resolveModel({ provider: "anthropic", id: "trusted" })).toMatchObject({
      id: "trusted", providerID: "anthropic", api: { npm: "@ai-sdk/anthropic" },
    });
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(authRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("invalid provider and absent model fail with typed identity before provider I/O", async () => {
    spyOn(ModelsDev, "get").mockResolvedValue(catalog);
    spyOn(Auth, "get").mockResolvedValue(undefined);
    const fetch = spyOn(globalThis, "fetch");
    for (const [provider, id, reason] of [
      ["missing", "trusted", "provider_not_found"],
      ["anthropic", "absent", "model_not_found"],
    ] as const) {
      await expect(Provider.resolveModel({ provider, id })).rejects.toMatchObject({
        name: "ModelResolutionError", data: { provider, model: id, reason },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("positive proxy discovery retains model identity and reports listing failure", async () => {
    spyOn(ModelsDev, "get").mockResolvedValue(catalog);
    spyOn(Auth, "get").mockResolvedValue({ type: "proxy", baseURL: "https://proxy.example" });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "proxy-only" }] }),
    );
    expect(await Provider.resolveModel({ provider: "anthropic", id: "proxy-only" })).toMatchObject({
      id: "proxy-only", providerID: "anthropic",
    });
    spyOn(Auth, "get").mockResolvedValue({ type: "proxy", baseURL: "https://broken-proxy.example" });
    fetch.mockRejectedValue(new Error("connection refused"));
    await expect(Provider.resolveModel({ provider: "anthropic", id: "absent" })).rejects.toMatchObject({
      data: { reason: "proxy_listing_failed" }, cause: expect.any(Error),
    });
  });

  test("cross-provider fallback reads its own credential, never the primary key", async () => {
    const primary = { type: "api", key: "primary-key" } as const;
    const fallback = { type: "api", key: "fallback-key" } as const;
    const get = spyOn(Auth, "get").mockResolvedValue(fallback);
    expect(await Auth.resolve("anthropic", primary, "anthropic")).toEqual(primary);
    expect(get).not.toHaveBeenCalled();
    expect(await Auth.resolve("openai", primary, "anthropic")).toEqual(fallback);
    expect(get.mock.calls).toEqual([["openai"]]);
  });

  test("missing, invalid and forbidden fallback credentials fail before I/O", async () => {
    const get = spyOn(Auth, "get").mockResolvedValue(undefined);
    const fetch = spyOn(globalThis, "fetch");
    await expect(Auth.resolve("anthropic", { type: "api", key: "" })).rejects.toMatchObject({
      name: "AuthResolutionError", data: { reason: "invalid_auth", provider: "anthropic" },
    });
    await expect(Auth.resolve("openai", { type: "api", key: "primary" }, "anthropic", false)).rejects.toMatchObject({
      data: { reason: "missing_auth", provider: "openai" },
    });
    expect(get).not.toHaveBeenCalled();
    await expect(Auth.resolve("openai")).rejects.toMatchObject({ data: { reason: "missing_auth" } });
    expect(get.mock.calls).toEqual([["openai"]]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
