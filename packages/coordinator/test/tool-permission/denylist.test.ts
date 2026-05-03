import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkPermission, loadPolicy, type PolicyConfig } from "../../src/tool-permission";

const TMP = join(tmpdir(), `openomni-perm-test-${process.pid}`);
const POLICY_PATH = join(TMP, "tool-policy.json");

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadPolicy", () => {
  test("returns empty object when file does not exist", () => {
    expect(loadPolicy(join(TMP, "nonexistent.json"))).toEqual({});
  });

  test("parses policy file correctly", () => {
    const policy: PolicyConfig = {
      denylist: ["mytool"],
      allowlist: ["safetool"],
      userOverrides: { bash: "allow" },
    };
    writeFileSync(POLICY_PATH, JSON.stringify(policy));
    expect(loadPolicy(POLICY_PATH)).toEqual(policy);
  });

  test("returns empty object on malformed JSON", () => {
    const badPath = join(TMP, "bad.json");
    writeFileSync(badPath, "{ not json }");
    expect(loadPolicy(badPath)).toEqual({});
  });
});

describe("checkPermission — denylist", () => {
  test("denies tool in denylist", () => {
    const policy: PolicyConfig = { denylist: ["danger"] };
    const result = checkPermission("danger", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denylist");
    expect(result.tier).toBe("user-override");
  });

  test("allows tool in allowlist", () => {
    const policy: PolicyConfig = { allowlist: ["safetool"] };
    const result = checkPermission("safetool", policy);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("allowlist");
    expect(result.tier).toBe("user-override");
  });

  test("denies tool outside allowlist using canonical fail-closed semantics", () => {
    const policy: PolicyConfig = { allowlist: ["safetool"] };
    const result = checkPermission("othertool", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("allowlist_miss");
    expect(result.tier).toBe("user-override");
  });

  test("matches prefix patterns through the guardrail evaluator", () => {
    const policy: PolicyConfig = { denylist: ["filesystem.*"] };
    const result = checkPermission("filesystem.write", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denylist");
    expect(result.tier).toBe("user-override");
  });
});

describe("checkPermission — risk defaults", () => {
  test("denies bash by risk default", () => {
    const result = checkPermission("bash", {});
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("risk-default");
  });

  test("denies shell by risk default", () => {
    const result = checkPermission("shell", {});
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("risk-default");
  });

  test("denies rm by risk default", () => {
    const result = checkPermission("rm", {});
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("risk-default");
  });

  test("allows echo by risk default", () => {
    const result = checkPermission("echo", {});
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("default_allow");
    expect(result.tier).toBe("risk-default");
  });
});

describe("checkPermission — unknown tool", () => {
  test("allows lower-risk unknown tool with unknown-default tier", () => {
    const result = checkPermission("some-custom-tool-xyz", {});
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("default_allow");
    expect(result.tier).toBe("unknown-default");
  });

  test("denies high-risk unknown tool by default", () => {
    const result = checkPermission("some-custom-tool-xyz", {}, { riskTier: 2 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denylist");
    expect(result.tier).toBe("unknown-default");
  });
});

describe("checkPermission — user override precedence", () => {
  test("user override allow beats risk default deny (bash)", () => {
    const policy: PolicyConfig = { userOverrides: { bash: "allow" } };
    const result = checkPermission("bash", policy);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("user_override_allow");
    expect(result.tier).toBe("user-override");
  });

  test("user override deny beats risk default allow (echo)", () => {
    const policy: PolicyConfig = { userOverrides: { echo: "deny" } };
    const result = checkPermission("echo", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_override_deny");
    expect(result.tier).toBe("user-override");
  });

  test("user override takes precedence over denylist", () => {
    const policy: PolicyConfig = {
      denylist: ["mytool"],
      userOverrides: { mytool: "allow" },
    };
    const result = checkPermission("mytool", policy);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("user_override_allow");
    expect(result.tier).toBe("user-override");
  });
});
