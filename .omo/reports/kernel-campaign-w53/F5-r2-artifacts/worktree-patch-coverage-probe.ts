// F5-r2 worktree patch-coverage probe: gate the lane's UNCOMMITTED changed
// executable lines (git diff --unified=0 HEAD -- <owned prod files>) against
// the merged lcov union, mirroring the base...HEAD gate's own logic.
import { changedLines, lcovUnion, uncoveredRows, hasExecutableCode } from "/Users/ino/Develop/openomni-w53/script/check-patch-coverage.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = "/Users/ino/Develop/openomni-w53";
const files = [
  "packages/agent/src/session-lifecycle/inspect.ts",
  "apps/openomni/src/gateway.ts",
];
const diff = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-renames", "--unified=0", "HEAD", "--", ...files], { cwd: root, stdout: "pipe" });
const changed = changedLines(diff.stdout.toString());
import tsc from "typescript";
const lcovs = ["packages/agent/coverage/lcov.info", "apps/openomni/coverage/lcov.info"].map((p) => resolve(root, p));
const union = lcovUnion(lcovs, root);
// Gate executable lines only: filter with the same TS parse the gate uses.
function nonExecutable(text: string, path: string): Set<number> {
  const source = tsc.createSourceFile(path, text, tsc.ScriptTarget.Latest, true);
  const skipped = new Set(source.getLineStarts().map((_s, i) => i + 1));
  const visit = (node: import("typescript").Node): void => {
    if (tsc.isImportDeclaration(node) || tsc.isExportDeclaration(node) || tsc.isTypeAliasDeclaration(node) || tsc.isInterfaceDeclaration(node) || tsc.isTypeNode(node) || tsc.isJSDoc(node)) return;
    const children = node.getChildren(source);
    if (children.length > 0) { for (const child of children) visit(child); return; }
    const start = node.getStart(source);
    if (start === node.end) return;
    const first = source.getLineAndCharacterOfPosition(start).line + 1;
    const last = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
    for (let line = first; line <= last; line += 1) skipped.delete(line);
  };
  visit(source);
  return skipped;
}
for (const [path, lines] of changed) {
  const skip = nonExecutable(readFileSync(resolve(root, path), "utf8"), path);
  changed.set(path, new Set([...lines].filter((line) => !skip.has(line))));
}
const rows = uncoveredRows(changed, union, (path) => hasExecutableCode(readFileSync(resolve(root, path), "utf8"), path));
for (const [path, lines] of changed) console.log(`gated ${path}: ${lines.size} changed executable line(s)`);
for (const row of rows) console.error(`uncovered: ${row}`);
console.log(rows.length === 0 ? "worktree patch coverage: all changed executable lines covered" : `worktree patch coverage: ${rows.length} uncovered`);
process.exit(rows.length === 0 ? 0 : 1);
