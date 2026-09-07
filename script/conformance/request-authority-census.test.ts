import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as protocol from "../../packages/protocol/src/index";
import { authorityViolations, scanRequestAuthority } from "../request-authority-census";

const root = join(import.meta.dir, "../..");
const retiredStore = ["Wait", "Store"].join("");
const retiredApproval = ["Approval", "SubAdapter"].join("");
const waitTable = "wait";
const approvalTable = "approval";

describe("original-action authority census", () => {
  test("production, fixtures, and public schema contain no independent legacy authority", async () => {
    const result = await scanRequestAuthority(root);
    for (const band of ["production", "fixtures", "schema"] as const) {
      expect(result.scanned[band], `empty ${band} census`).toBeGreaterThan(0);
    }
    expect(result.violations).toEqual([]);
  }, 15_000);

  test.each([
    "apps/probe/src/authority.ts",
    "packages/probe/test/helpers/authority.ts",
    "packages/probe/src/__tests__/authority.test.ts",
    "script/fixtures/authority.ts",
    "packages/protocol/src/storage/authority.ts",
  ])("rejects an independent authority mutant at %s", (path) => {
    expect(
      authorityViolations(path, `import { ${retiredStore} as store } from "@openomni/ledger";`),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-api", path }));
  });

  test("archival exceptions permit old SQL, never resurrected APIs", () => {
    const path = "packages/ledger/test/storage/request-migration.test.ts";
    const source = `db.exec("UPDATE ${waitTable} SET status = 'open'");`;
    expect(authorityViolations(path, source)).toEqual([]);
    expect(authorityViolations(path, `export interface ${retiredApproval} {}`)).toContainEqual(
      expect.objectContaining({ rule: "legacy-api" }),
    );
    expect(
      authorityViolations("packages/ledger/src/storage/u969-preflight.ts", source),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-sql" }));
  });

  test.each([
    `db.exec(\`UPDATE\n"main"."${waitTable}" SET status = 'open'\`)`,
    `db.exec("INSERT INTO [${approvalTable}] (id) VALUES (?)")`,
    `db.exec("DELETE FROM \`${waitTable}\`")`,
    `db.exec("SELECT * FROM ${approvalTable}")`,
  ])("rejects legacy SQL outside the exact archive operation allowance: %s", (source) => {
    expect(authorityViolations("packages/probe/test/fixture.ts", source)).toContainEqual(
      expect.objectContaining({ rule: "legacy-sql" }),
    );
  });

  test("public snapshots and serialized correlation names cannot retain retired vocabulary", () => {
    expect(
      authorityViolations(
        "script/conformance/schema-snapshot.json",
        JSON.stringify({
          [["Wait", "Record"].join(".")]: [["wait", "Id"].join("")],
        }),
      ),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-api" }));
  });

  test("the actual public barrel has no independent authority or cross-session delivery commit", () => {
    const exports = Object.keys(protocol);
    for (const domain of ["Wait", "Approval"]) expect(exports).not.toContain(domain);
    expect(Object.keys(protocol.LedgerSession.Commit.shape)).not.toContain("deliveries");
    expect(Object.keys(protocol.SessionTransition.Request.shape)).toContain("requestId");
  });

  test("a read-only migration exception cannot delete old live rows", () => {
    const source = `db.exec("DELETE FROM ${waitTable}")`;
    expect(
      authorityViolations("packages/ledger/src/storage/u969-preflight.ts", source),
    ).toContainEqual(expect.objectContaining({ rule: "legacy-sql" }));
  });

  test("frozen archive formats cannot become a public compatibility alias", () => {
    const source = 'export * from "../../ledger/src/storage/historical-request-format";';
    expect(authorityViolations("packages/protocol/src/index.ts", source)).toContainEqual(
      expect.objectContaining({ rule: "archive-boundary" }),
    );
  });

  test("the real git census sees untracked fixtures and rejects a reintroduced writer", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "request-census-"));
    try {
      const init = Bun.spawn(["git", "init", "--quiet", fixture], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await init.exited).toBe(0);
      const path = "packages/probe/test/helpers/authority.ts";
      await mkdir(join(fixture, "packages/probe/test/helpers"), { recursive: true });
      await writeFile(join(fixture, path), `export const store = ${retiredStore}.create();`);
      const retiredPath = `packages/protocol/src/${waitTable}/index.ts`;
      await mkdir(join(fixture, "packages/protocol/src", waitTable), { recursive: true });
      await writeFile(join(fixture, retiredPath), "");
      const result = await scanRequestAuthority(fixture);
      expect(result.violations).toContainEqual(
        expect.objectContaining({ path, rule: "legacy-api" }),
      );
      expect(result.violations).toContainEqual(
        expect.objectContaining({ path: retiredPath, rule: "legacy-path" }),
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
