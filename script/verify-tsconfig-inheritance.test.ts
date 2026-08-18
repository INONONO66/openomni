import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixtureManifest, repoManifest, verifyManifest } from "./verify-tsconfig-inheritance";

const fixturesDir = join(import.meta.dir, "fixtures", "tsconfig-inheritance");
const verifierPath = join(import.meta.dir, "verify-tsconfig-inheritance.ts");

function verifyFixture(name: string) {
  return verifyManifest(loadFixtureManifest(join(fixturesDir, `${name}.json`)));
}

describe("verify-tsconfig-inheritance", () => {
  test("repo: every project extends the shared base with intact emit policy and membership", () => {
    const result = verifyManifest(repoManifest());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.code).toBeNull();
    // 29 tsconfig projects existed at the #501 baseline; discovery may only grow.
    expect(result.projectCount).toBeGreaterThanOrEqual(29);
    expect(result.claimedFileCount).toBeGreaterThan(0);
  });

  test("known-bad fixture: a missing base config fails closed", () => {
    const result = verifyFixture("missing-base");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_base_config");
  });

  test("known-bad fixture: an omitted input fails the source-membership comparison", () => {
    const result = verifyFixture("omitted-input");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("omitted_input");
    expect(result.problems[0]?.message).toContain("orphan.ts");
  });

  test("known-bad fixture: an emit/declaration mutation fails the emit-policy comparison", () => {
    const result = verifyFixture("declaration-mutation");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("emit_policy_drift");
    const rendered = result.problems.map((problem) => problem.message).join("\n");
    expect(rendered).toContain("declaration resolved to false, expected true");
    expect(rendered).toContain("noEmit resolved to true, expected false");
  });

  test("valid fixture passes, including declaration-output derivation", () => {
    const result = verifyFixture("valid");
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.code).toBeNull();
  });

  test("CLI --fixture --json exits nonzero with a machine-readable code", async () => {
    const proc = Bun.spawn(
      ["bun", "run", verifierPath, "--fixture", join(fixturesDir, "missing-base.json"), "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("missing_base_config");
  });
});
