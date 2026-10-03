import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");

/**
 * One writer per journal kind (#1252): every `LedgerAction.Append` object
 * literal spelling `kind: "<journal kind>"` must live in the module the
 * kind's declaration header names as its single writer. An Append literal is
 * recognized by its `irreversible` or `parentId` sibling property; intent
 * payload literals (e.g. `value: { kind: "alarm", ... }`) carry neither and
 * never count.
 */

export interface JournalWriterDeclaration {
  readonly kind: string;
  /** Module path from the declaration header; a trailing `/` names a directory. */
  readonly writer: string;
  readonly declarationFile: string;
}

export interface JournalWriterFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly writer: string;
}

const DECLARATION_GLOB = "packages/protocol/src/journal/{core,capability}/*.ts";
const KIND_PATTERN = /declare\(\s*\n?\s*"([^"]+)"/;
const WRITER_PATTERN = /`((?:packages|apps)\/[^`]+)`/;

/** The declared single-writer registry parsed from the declaration headers. */
export function journalWriterDeclarations(root: string = ROOT): JournalWriterDeclaration[] {
  const declarations: JournalWriterDeclaration[] = [];
  for (const path of new Bun.Glob(DECLARATION_GLOB).scanSync({ cwd: root, onlyFiles: true })) {
    const source = readFileSync(join(root, path), "utf8");
    const kind = KIND_PATTERN.exec(source)?.[1];
    const writer = WRITER_PATTERN.exec(source)?.[1];
    if (kind === undefined || writer === undefined) {
      throw new Error(`journal declaration ${path} lacks a kind or a backticked writer module`);
    }
    declarations.push({ kind, writer, declarationFile: path });
  }
  return declarations.sort((a, b) => a.kind.localeCompare(b.kind));
}

function appendLiteralKind(node: ts.ObjectLiteralExpression, kinds: ReadonlySet<string>): string | undefined {
  let kind: string | undefined;
  let appendShaped = false;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = property.name.getText();
    if (name === "irreversible" || name === "parentId") appendShaped = true;
    if (
      name === "kind" &&
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.initializer) &&
      kinds.has(property.initializer.text)
    ) {
      kind = property.initializer.text;
    }
  }
  return appendShaped ? kind : undefined;
}

function writerOwns(file: string, writer: string): boolean {
  return writer.endsWith("/") ? file.startsWith(writer) : file === writer;
}

/** Every Append literal site checked against the declared writer registry. */
export function journalWriterFindings(root: string = ROOT): JournalWriterFinding[] {
  const declarations = journalWriterDeclarations(root);
  const writers = new Map(declarations.map((entry) => [entry.kind, entry.writer]));
  const kinds = new Set(writers.keys());
  const findings: JournalWriterFinding[] = [];
  for (const pattern of ["packages/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"]) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      if (/\.test\.tsx?$/.test(path)) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(join(root, path), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const kind = appendLiteralKind(node, kinds);
          // A recognized kind always has a declared writer: the kind set is
          // built from the writer registry's keys.
          const writer = kind === undefined ? undefined : writers.get(kind);
          if (kind !== undefined && writer !== undefined) {
            const file = relative(root, join(root, path));
            if (!writerOwns(file, writer)) findings.push({ file, line: line(source, node), kind, writer });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function line(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** CLI shell: prints violations and returns the exit code. */
export function checkJournalWriters(root: string | undefined): number {
  if (root === undefined || !existsSync(root)) {
    process.stderr.write("ERROR: --root requires an existing directory\n");
    return 1;
  }
  const findings = journalWriterFindings(root);
  for (const finding of findings) {
    process.stderr.write(
      `VIOLATION [journal-writers] ${finding.file}:${finding.line} kind "${finding.kind}" is owned by ${finding.writer}\n`,
    );
  }
  if (findings.length > 0) return 1;
  process.stdout.write(
    `OK: journal kinds with a single declared writer: ${journalWriterDeclarations(root).length}\n`,
  );
  return 0;
}

const cliRoot = process.argv[2] === "--root" ? process.argv[3] : ROOT;
if (import.meta.main) process.exitCode = checkJournalWriters(cliRoot);
