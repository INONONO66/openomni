import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

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

describe("loadConfig ws exposure", () => {
  it("refuses a non-loopback host without an upgrade token", () => {
    process.env.OPENOMNI_WS_HOST = "0.0.0.0";
    expect(() => loadConfig()).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
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
