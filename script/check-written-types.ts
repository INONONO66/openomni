import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");

export interface WrittenTypeFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: "any" | "unknown";
}

/** The PR gate counts syntax, not inferred types or words in comments and strings. */
export function writtenTypes(root: string = ROOT): WrittenTypeFinding[] {
  const findings: WrittenTypeFinding[] = [];
  // #1318: test sources are gated too — the literal-zero definition of done
  // makes no test exemption. `script/*.ts` already matches `script/*.test.ts`.
  const patterns = [
    "packages/*/src/**/*.{ts,tsx}",
    "apps/*/src/**/*.{ts,tsx}",
    "packages/*/test/**/*.{ts,tsx}",
    "apps/*/test/**/*.{ts,tsx}",
    "script/*.ts",
  ];
  for (const pattern of patterns) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      const source = ts.createSourceFile(
        path,
        readFileSync(join(root, path), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
          findings.push({
            file: relative(root, join(root, path)),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            kind: node.kind === ts.SyntaxKind.AnyKeyword ? "any" : "unknown",
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind),
  );
}

/** CLI shell around `writtenTypes`: prints findings and returns the exit code. */
export function checkWrittenTypes(root: string | undefined): number {
  if (root === undefined || !existsSync(root)) {
    process.stderr.write("ERROR: --root requires an existing directory\n");
    return 1;
  }
  const findings = writtenTypes(root);
  for (const finding of findings) {
    process.stderr.write(
      `VIOLATION [written-types] ${finding.file}:${finding.line} ${finding.kind}\n`,
    );
  }
  if (findings.length > 0) return 1;
  process.stdout.write("OK: written any/unknown types: 0\n");
  return 0;
}

const cliRoot = process.argv[2] === "--root" ? process.argv[3] : ROOT;
if (import.meta.main) process.exitCode = checkWrittenTypes(cliRoot);
