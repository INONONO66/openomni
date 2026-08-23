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

  it("refuses injected non-loopback config before binding", () => {
    expect(() =>
      startOpenOmni({
        config: {
          dbPath: "/dev/null/never-created.db",
          host: "0.0.0.0",
          wsPort: 0,
          model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
        },
      }),
    ).toThrow("OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback");
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
});
