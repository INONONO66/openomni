import { join } from "node:path";
import ts from "typescript";

interface Violation {
  readonly path: string;
  readonly line: number;
  readonly rule: "legacy-api" | "legacy-sql" | "legacy-path" | "archive-boundary";
  readonly match: string;
}

// No file is exempt from the API check, including migration tests and archives.
const domains = ["Wait", "Approval"];
const retiredIdentifiers = new Set([
  ...domains,
  ...domains.flatMap((name) =>
    ["Store", "SubAdapter", "Service", "Control", "Context"].map((suffix) => name + suffix),
  ),
  ...["Id", "Spec", "Context", "_correlation"].map((suffix) => `wait${suffix}`),
  ...["arm", "expire", "fire"].map((prefix) =>
    [prefix, "Message", "Deadline", prefix === "expire" ? "s" : ""].join(""),
  ),
  ...["claim", "message"].map(
    (prefix) => prefix + (prefix === "claim" ? "MessageAnswer" : "AnswerAppend"),
  ),
  ["message", "DeadlineArm"].join(""),
  ["message", "TimeoutInbox"].join(""),
  ["Message", "Deadline"].join(""),
]);
const retiredText = new RegExp(
  `\\b(?:${[...retiredIdentifiers].filter((name) => !domains.includes(name)).join("|")})\\b|` +
    `\\b(?:${domains.join("|")})\\.[A-Z][A-Za-z]*|` +
    `\\b(?:wait|approval)\\.(?:requested|resolved|expired|cancelled|decided)\\b|` +
    `(?:sqlite-)?(?:wait|approval)-(?:adapter|store|service|fold)\\b`,
  "g",
);
const retiredPath =
  /\/(?:protocol\/src\/(?:wait|approval)|ledger\/src\/(?:wait|approval)|channels\/src\/router\/wait)(?:\/|$)|\/sqlite-(?:wait|approval)-adapter\.ts$/;
const legacySql =
  /\b(?:from|join|into|update(?:\s+or\s+\w+)?|table(?:\s+if\s+(?:not\s+)?exists)?)\s+(?:(?:"main"|main)\s*\.\s*)?(?:"(?:wait|approval)"|`(?:wait|approval)`|\[(?:wait|approval)\]|'(?:wait|approval)'|(?:wait|approval)\b)/gi;

// Operation-scoped archival exceptions, not test-tree or whole-file exclusions.
// The preflight can read old rows but cannot become a live lifecycle writer.
const readOnlySql = new Set([
  "packages/ledger/src/storage/u967-projection.ts",
  "packages/ledger/src/storage/u969-preflight.ts",
]);
const archiveFixtureSql = new Set([
  "packages/ledger/test/helpers/disposition-967.ts",
  "packages/ledger/test/helpers/disposition-967-fault.ts",
  "packages/ledger/test/storage/u967-disposition-cases.ts",
  "packages/ledger/test/storage/storage-boundaries.test.ts",
  "packages/ledger/test/storage/request-migration.test.ts",
  "script/generate-ledger-archive-manifest.test.ts",
  "script/ledger-archive-review-r2.test.ts",
]);
const historicalSql = new Set([
  "packages/ledger/migration/0012_wait/migration.sql",
  "packages/ledger/migration/0028_approval/migration.sql",
  "packages/ledger/migration/0034_u967_archive_disposition/migration.sql",
  "packages/ledger/migration/0038_session_requests/migration.sql",
]);
const historicalFormats = new Set([
  "packages/ledger/src/storage/historical-request-format.ts",
  "packages/ledger/src/storage/u967-projection.ts",
  "packages/ledger/src/storage/u969-preflight.ts",
  "packages/ledger/test/helpers/disposition-967.ts",
  "script/ledger-archive-review-r2.test.ts",
]);

export function authorityViolations(path: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const record = (rule: Violation["rule"], match: string, offset: number) => {
    violations.push({
      path,
      line: file.getLineAndCharacterOfPosition(offset).line + 1,
      rule,
      match,
    });
  };
  if (retiredPath.test(path)) record("legacy-path", path, 0);
  const checkText = (text: string, offset: number) => {
    for (const match of text.matchAll(retiredText)) {
      // This exact historical event exercises hash-chain adoption, not a live store.
      if (
        path === "packages/ledger/test/ledger-core/adopt.test.ts" &&
        text === ["wait", "resolved"].join(".")
      )
        continue;
      record("legacy-api", match[0], offset);
    }
    for (const match of text.matchAll(legacySql)) {
      const allowed =
        historicalSql.has(path) ||
        archiveFixtureSql.has(path) ||
        (readOnlySql.has(path) &&
          /^(?:from|join)\b/i.test(match[0]) &&
          !/\b(?:insert|replace|update|delete|drop|alter|create)\b/i.test(text)) ||
        (path === "script/generate-ledger-archive-manifest.ts" &&
          text ===
            [
              "DELETE FROM",
              "wait",
              "WHERE id = ? AND revision = ? AND owner_kind = 'workItem'",
            ].join(" "));
      if (!allowed) record("legacy-sql", match[0], offset);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && retiredIdentifiers.has(node.text)) {
      record("legacy-api", node.text, node.getStart(file));
    }
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      checkText(node.text, node.getStart(file));
    }
    if (!historicalFormats.has(path)) {
      if (ts.isIdentifier(node) && domains.some((domain) => node.text === `Historical${domain}`)) {
        record("archive-boundary", node.text, node.getStart(file));
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.includes("historical-request-format")
      ) {
        record("archive-boundary", node.moduleSpecifier.text, node.getStart(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  if (path.endsWith(".sql")) checkText(source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ""), 0);
  else visit(file);
  return violations;
}

export async function scanRequestAuthority(root: string) {
  // git grep works on Linux CI, includes untracked fixtures during local work,
  // respects ignored build output, and never excludes tests or public schemas.
  const process = Bun.spawn(
    [
      "git",
      "grep",
      "--untracked",
      "--exclude-standard",
      "-I",
      "-l",
      "-z",
      "-E",
      [
        "Wait",
        "Approval",
        "wait",
        "approval",
        ["Message", "Deadline"].join(""),
        "messageDeadline",
        "MessageAnswer",
        "messageAnswer",
        "messageTimeout",
        "historical-request-format",
      ].join("|"),
      "--",
      "apps",
      "packages",
      "script",
      ":(exclude)**/dist/**",
      ":(exclude)**/node_modules/**",
      ":(exclude)**/coverage/**",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const inventory = Bun.spawn(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps",
      "packages",
      "script",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const [inventoryOut, inventoryError, inventoryCode] = await Promise.all([
    new Response(inventory.stdout).text(),
    new Response(inventory.stderr).text(),
    inventory.exited,
  ]);
  if (code !== 0 && code !== 1)
    throw new Error(`authority census git grep failed (${code}): ${stderr}`);
  if (inventoryCode !== 0) throw new Error(`authority census inventory failed: ${inventoryError}`);
  const paths = [
    ...new Set([
      ...stdout.split("\0").filter((path) => /\.(?:[cm]?[jt]sx?|json|sql)$/.test(path)),
      ...inventoryOut.split("\0").filter((path) => retiredPath.test(path)),
    ]),
  ].sort();
  const scanned = { production: 0, fixtures: 0, schema: 0 };
  const violations: Violation[] = [];
  for (const path of paths) {
    // The index still lists files deleted by an uncommitted cutover.
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    if (
      path.startsWith("packages/protocol/src/") ||
      (path.startsWith("script/conformance/") && path.endsWith(".json"))
    )
      scanned.schema += 1;
    else if (
      /\/(?:test|tests|__tests__|fixtures)\//.test(path) ||
      /\.(?:test|spec)\.tsx?$/.test(path)
    )
      scanned.fixtures += 1;
    else scanned.production += 1;
    violations.push(...authorityViolations(path, await file.text()));
  }
  return { scanned, violations };
}

if (import.meta.main) {
  const result = await scanRequestAuthority(join(import.meta.dir, ".."));
  console.log(JSON.stringify(result, null, 2));
  if (result.violations.length > 0) process.exitCode = 1;
}
