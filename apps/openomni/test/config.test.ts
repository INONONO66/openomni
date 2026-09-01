import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { assertWsExposure, loadConfig } from "../src/config";
import { startOpenOmni } from "../src/index";

const ENV_KEYS = [
  "OPENOMNI_DB_PATH",
  "OPENOMNI_WS_HOST",
  "OPENOMNI_WS_PORT",
  "OPENOMNI_WS_TOKEN",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_MODEL_BASE_URL",
  "OPENOMNI_MODEL_HEADERS",
  "OPENOMNI_SOCIAL_BUDGETS",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OPENOMNI_MODEL_PROVIDER = "fake";
  process.env.OPENOMNI_MODEL_ID = "resident-test";
  process.env.OPENOMNI_MODEL_API_KEY = "test-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ws exposure enforcement", () => {
  it("refuses a non-loopback host without an upgrade token", () => {
    expect(() => assertWsExposure({ host: "0.0.0.0" })).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
    expect(() => assertWsExposure({ host: "0.0.0.0", wsToken: "" })).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
  });

  it("refuses injected non-loopback config before binding", async () => {
    // `/dev/null/...` cannot be opened: if the refusal ever stopped preceding
    // the ledger and the bind, this would fail on that path instead.
    await expect(
      startOpenOmni({
        config: {
          dbPath: "/dev/null/never-created.db",
          memoryPath: "/dev/null/never-created.memory.json",
          host: "0.0.0.0",
          wsPort: 0,
          model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
        },
      }),
    ).rejects.toThrow("OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback");
  });

  it("accepts a non-loopback host once a token is set", () => {
    process.env.OPENOMNI_WS_HOST = "0.0.0.0";
    process.env.OPENOMNI_WS_TOKEN = "shared-secret";
    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.wsToken).toBe("shared-secret");
  });

  it("allows loopback without a token and omits the field", () => {
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect("wsToken" in config).toBe(false);
  });

  it("leaves the model transport overrides absent when unset", () => {
    const config = loadConfig();
    expect("baseUrl" in config.model).toBe(false);
    expect("headers" in config.model).toBe(false);
  });

  it("reads the operator's model base URL and headers", () => {
    process.env.OPENOMNI_MODEL_BASE_URL = "https://gateway.internal/v1";
    process.env.OPENOMNI_MODEL_HEADERS = JSON.stringify({
      "x-tenant": "acme",
      "user-agent": "acme-fleet/2",
    });

    const config = loadConfig();

    expect(config.model.baseUrl).toBe("https://gateway.internal/v1");
    expect(config.model.headers).toEqual({ "x-tenant": "acme", "user-agent": "acme-fleet/2" });
  });

  it("fails closed on malformed OPENOMNI_MODEL_HEADERS JSON", () => {
    process.env.OPENOMNI_MODEL_HEADERS = "{not json";

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_HEADERS is invalid JSON");
  });

  it.each([
    { name: "a JSON array", value: JSON.stringify(["x-tenant", "acme"]) },
    { name: "a bare string", value: JSON.stringify("x-tenant: acme") },
    { name: "non-string header values", value: JSON.stringify({ "x-retries": 3 }) },
    { name: "an empty header name", value: JSON.stringify({ "": "acme" }) },
    { name: "a header name containing a CR/LF", value: JSON.stringify({ "x-bad\r\ninjected": "acme" }) },
    { name: "a header value containing a CR/LF", value: JSON.stringify({ "x-tenant": "acme\r\ninjected" }) },
  ])("fails closed on $name", ({ value }) => {
    process.env.OPENOMNI_MODEL_HEADERS = value;

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_HEADERS is invalid");
  });

  it("reads explicit social budgets while keeping the default absent", () => {
    expect(loadConfig().socialBudgets).toBeUndefined();
    process.env.OPENOMNI_SOCIAL_BUDGETS = JSON.stringify([
      {
        id: "budget:alice",
        targetActorId: "alice",
        maxPerWindow: 2,
        windowMs: 60_000,
        cooldownMs: 0,
      },
    ]);
    expect(loadConfig().socialBudgets).toEqual([
      {
        id: "budget:alice",
        targetActorId: "alice",
        maxPerWindow: 2,
        windowMs: 60_000,
        cooldownMs: 0,
      },
    ]);
  });
});
