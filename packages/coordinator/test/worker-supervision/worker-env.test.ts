import { describe, expect, test } from "bun:test";
import { buildWorkerEnv } from "../../src/worker-supervision/supervisor-process.js";

describe("buildWorkerEnv", () => {
  test("the production default excludes the test-fixture keys", () => {
    // These two rode the production allowlist for the fixtures' convenience
    // (#606 re-audit); a fixture knob a production worker inherits is an
    // undocumented behavior toggle. Tests forward them via extraEnvKeys.
    const env = buildWorkerEnv({
      PATH: "/usr/bin",
      OPENOMNI_WORKER_ENV_FIXTURE: "leak",
      OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS: "250",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("explicit extra keys are forwarded on top of the allowlist", () => {
    const env = buildWorkerEnv(
      {
        PATH: "/usr/bin",
        OPENOMNI_WORKER_ENV_FIXTURE: "fixture-value",
        DISCORD_BOT_TOKEN: "secret",
      },
      ["OPENOMNI_WORKER_ENV_FIXTURE"],
    );

    expect(env).toEqual({ PATH: "/usr/bin", OPENOMNI_WORKER_ENV_FIXTURE: "fixture-value" });
  });
});
