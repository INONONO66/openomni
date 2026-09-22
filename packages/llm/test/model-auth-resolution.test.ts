import { Effect } from "effect";
import { runEffect } from "./helpers/native";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Auth, Provider } from "../src";
import { ModelsDev } from "../src/model";

const catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: [],
    models: { trusted: { id: "trusted", name: "Trusted", limit: { context: 1000 } } },
  },
};

afterEach(() => mock.restore());

describe("canonical model and provider-bound credentials", () => {
  test("trusted catalog identity is exact and needs no discovery I/O", async () => {
    const catalogRead = spyOn(ModelsDev, "get").mockReturnValue(Effect.succeed(catalog));
    const authRead = spyOn(Auth, "get").mockReturnValue(Effect.succeed(undefined));
    const fetch = spyOn(globalThis, "fetch");
    expect(await runEffect(Provider.resolveModel({ provider: "anthropic", id: "trusted" }))).toMatchObject({
      id: "trusted",
      providerID: "anthropic",
      api: { npm: "@ai-sdk/anthropic" },
    });
    expect(catalogRead).toHaveBeenCalledTimes(1);
    expect(authRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("invalid provider and absent model fail with typed identity before provider I/O", async () => {
    spyOn(ModelsDev, "get").mockReturnValue(Effect.succeed(catalog));
    spyOn(Auth, "get").mockReturnValue(Effect.succeed(undefined));
    const fetch = spyOn(globalThis, "fetch");
    for (const [provider, id, reason] of [
      ["missing", "trusted", "provider_not_found"],
      ["anthropic", "absent", "model_not_found"],
    ] as const) {
      await expect(runEffect(Provider.resolveModel({ provider, id }))).rejects.toMatchObject({
        name: "ModelResolutionError",
        provider, model: id, reason,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("proxy discovery keeps valid IDs when entries are malformed", async () => {
    spyOn(ModelsDev, "get").mockReturnValue(Effect.succeed(catalog));
    spyOn(Auth, "get").mockReturnValue(Effect.succeed({ type: "proxy", baseURL: "https://mixed-proxy.example" }));
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "wanted" }, { id: 42 }, { other: "ignored" }] }),
    );
    expect(await runEffect(Provider.resolveModel({ provider: "anthropic", id: "wanted" }))).toMatchObject({
      id: "wanted",
      providerID: "anthropic",
    });
  });

  test("positive proxy discovery retains model identity and reports listing failure", async () => {
    spyOn(ModelsDev, "get").mockReturnValue(Effect.succeed(catalog));
    spyOn(Auth, "get").mockReturnValue(Effect.succeed({ type: "proxy", baseURL: "https://proxy.example" }));
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ id: "proxy-only" }] }),
    );
    expect(await runEffect(Provider.resolveModel({ provider: "anthropic", id: "proxy-only" }))).toMatchObject({
      id: "proxy-only",
      providerID: "anthropic",
    });
    spyOn(Auth, "get").mockReturnValue(Effect.succeed({
      type: "proxy",
      baseURL: "https://broken-proxy.example",
    }));
    fetch.mockRejectedValue(new Error("connection refused"));
    await expect(
      runEffect(Provider.resolveModel({ provider: "anthropic", id: "absent" })),
    ).rejects.toMatchObject({
      reason: "proxy_listing_failed",
      cause: expect.stringContaining("connection refused"),
    });
  });

  test("cross-provider fallback reads its own credential, never the primary key", async () => {
    const primary = { type: "api", key: "primary-key" } as const;
    const fallback = { type: "api", key: "fallback-key" } as const;
    const get = spyOn(Auth, "get").mockReturnValue(Effect.succeed(fallback));
    expect(await runEffect(Auth.resolve("anthropic", primary, "anthropic"))).toEqual(primary);
    expect(get).not.toHaveBeenCalled();
    expect(await runEffect(Auth.resolve("openai", primary, "anthropic"))).toEqual(fallback);
    expect(get.mock.calls).toEqual([["openai"]]);
  });

  test("missing, invalid and forbidden fallback credentials fail before I/O", async () => {
    const get = spyOn(Auth, "get").mockReturnValue(Effect.succeed(undefined));
    const fetch = spyOn(globalThis, "fetch");
    await expect(runEffect(Auth.resolve("anthropic", { type: "api", key: "" }))).rejects.toMatchObject({
      name: "AuthResolutionError",
      reason: "invalid_auth", provider: "anthropic",
    });
    await expect(
      runEffect(Auth.resolve("openai", { type: "api", key: "primary" }, "anthropic", false)),
    ).rejects.toMatchObject({
      reason: "missing_auth", provider: "openai",
    });
    expect(get).not.toHaveBeenCalled();
    await expect(runEffect(Auth.resolve("openai"))).rejects.toMatchObject({
      reason: "missing_auth",
    });
    expect(get.mock.calls).toEqual([["openai"]]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
