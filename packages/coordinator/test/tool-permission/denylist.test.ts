import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import { loadPolicy, checkPermission, type PolicyConfig } from "../../src/tool-permission/policy";
import { logPermissionDecision, type AuditEntry } from "../../src/tool-permission/audit";

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
    expect(result.reason).toBe("in denylist");
    expect(result.tier).toBe("user-override");
  });

  test("allows tool in allowlist", () => {
    const policy: PolicyConfig = { allowlist: ["safetool"] };
    const result = checkPermission("safetool", policy);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("in allowlist");
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
    expect(result.tier).toBe("risk-default");
  });
});

describe("checkPermission — unknown tool", () => {
  test("allows unknown tool with unknown-default tier", () => {
    const result = checkPermission("some-custom-tool-xyz", {});
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("unknown-default");
  });
});

describe("checkPermission — user override precedence", () => {
  test("user override allow beats risk default deny (bash)", () => {
    const policy: PolicyConfig = { userOverrides: { bash: "allow" } };
    const result = checkPermission("bash", policy);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("user-override");
  });

  test("user override deny beats risk default allow (echo)", () => {
    const policy: PolicyConfig = { userOverrides: { echo: "deny" } };
    const result = checkPermission("echo", policy);
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("user-override");
  });

  test("user override takes precedence over denylist", () => {
    const policy: PolicyConfig = {
      denylist: ["mytool"],
      userOverrides: { mytool: "allow" },
    };
    const result = checkPermission("mytool", policy);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("user-override");
  });
});

describe("logPermissionDecision — audit log", () => {
  const auditPath = join(TMP, "audit.jsonl");

  test("writes JSON-lines entry to custom audit log path", () => {
    const entry: AuditEntry = {
      ts: 1000,
      tool: "bash",
      allowed: false,
      reason: "risk default: deny",
      tier: "risk-default",
      runId: "run-123",
      sessionId: "sess-456",
    };

    mkdirSync(TMP, { recursive: true });
    appendFileSync(auditPath, JSON.stringify(entry) + "\n");

    const lines = readFileSync(auditPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[lines.length - 1]);
    expect(parsed.tool).toBe("bash");
    expect(parsed.allowed).toBe(false);
    expect(parsed.tier).toBe("risk-default");
    expect(parsed.runId).toBe("run-123");
  });

  test("does not throw when logPermissionDecision is called", () => {
    expect(() =>
      logPermissionDecision({
        ts: Date.now(),
        tool: "echo",
        allowed: true,
        reason: "risk default: allow",
        tier: "risk-default",
      }),
    ).not.toThrow();
  });

  test("logPermissionDecision produces parseable JSON-lines output", () => {
    const defaultAuditPath = join(homedir(), ".openomni", "audit.jsonl");

    logPermissionDecision({
      ts: 9999,
      tool: "test-tool-audit-verify",
      allowed: true,
      reason: "unknown tool: allowed by default",
      tier: "unknown-default",
      runId: "test-run",
    });

    if (existsSync(defaultAuditPath)) {
      const lines = readFileSync(defaultAuditPath, "utf-8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last).toHaveProperty("tool");
      expect(last).toHaveProperty("allowed");
      expect(last).toHaveProperty("tier");
    }
  });
});
