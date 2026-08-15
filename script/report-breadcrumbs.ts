/**
 * Issue-breadcrumb report (informational, NOT a CI gate).
 *
 * Source comments carry `#NNN` breadcrumbs pointing at the issue/PR that
 * motivated a decision. Once the referenced issue is CLOSED the breadcrumb is
 * a pruning candidate: either the constraint became self-evident (delete the
 * ref) or the comment should be rewritten to state the invariant directly.
 *
 * Deciding OPEN vs CLOSED requires the GitHub API — there is no robust
 * offline source of issue state, so this is deliberately shipped as a local
 * report instead of a CI gate (a gate that needs network in CI is worse than
 * no gate). When the `gh` CLI is available and authenticated, refs are
 * enriched with live state and CLOSED/MERGED ones are flagged; offline, the
 * report degrades to a plain occurrence listing.
 *
 * Modes:
 *   bun run script/report-breadcrumbs.ts              list refs (+ state via gh
 *                                                     when available); exit 0
 *   bun run script/report-breadcrumbs.ts --strict     exit 1 when any ref
 *                                                     resolves to CLOSED/MERGED
 *                                                     (opt-in local pre-push aid)
 *   bun run script/report-breadcrumbs.ts --self-test  scanner check on synthetic
 *                                                     fixtures only
 */

const SCAN_ROOTS = ["packages", "apps", "script"];
const EXCLUDED_PATH_PARTS = ["/dist/", "/node_modules/", "/coverage/", "/generated/"];
const EXCLUDED_SUFFIXES = [".d.ts", ".generated.ts", ".gen.ts"];

// Refs live in comments: `// ... #NNN`, `/* ... #NNN */`, or block-comment
// continuation lines (` * ... #NNN`). 2-5 digits skips noise like "#1"; the
// `(?:^|[^:])` guard keeps `https://...#123` inside strings from reading as a
// line comment (heuristic, not a tokenizer — this report is informational).
const LINE_COMMENT_REF = /(?:^|[^:])\/\/[^\n]*?#(\d{2,5})\b/g;
const BLOCK_LINE_REF = /^\s*\*[^\n]*?#(\d{2,5})\b/;
const REF_IN_TEXT = /#(\d{2,5})\b/g;

interface BreadcrumbRef {
  readonly issue: number;
  readonly filePath: string;
  readonly line: number;
  readonly text: string;
}

/** Extracts `#NNN` comment refs from one file's source. */
function scanSource(filePath: string, source: string): BreadcrumbRef[] {
  const refs: BreadcrumbRef[] = [];
  const lines = source.split("\n");
  let inBlockComment = false;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    const candidates = new Set<number>();

    if (inBlockComment) {
      const closing = line.indexOf("*/");
      const commentPart = closing === -1 ? line : line.slice(0, closing);
      for (const match of commentPart.matchAll(REF_IN_TEXT)) {
        candidates.add(Number(match[1]));
      }
      if (closing !== -1) {
        inBlockComment = false;
      }
    } else {
      LINE_COMMENT_REF.lastIndex = 0;
      for (const match of line.matchAll(LINE_COMMENT_REF)) {
        candidates.add(Number(match[1]));
      }
      const blockMatch = BLOCK_LINE_REF.exec(line);
      if (blockMatch?.[1] !== undefined) {
        candidates.add(Number(blockMatch[1]));
      }
      const opener = line.indexOf("/*");
      if (opener !== -1 && !line.includes("*/", opener)) {
        inBlockComment = true;
        for (const match of line.slice(opener).matchAll(REF_IN_TEXT)) {
          candidates.add(Number(match[1]));
        }
      } else if (opener !== -1) {
        const inline = line.slice(opener, line.indexOf("*/", opener));
        for (const match of inline.matchAll(REF_IN_TEXT)) {
          candidates.add(Number(match[1]));
        }
      }
    }

    for (const issue of candidates) {
      refs.push({ issue, filePath, line: index + 1, text: line.trim() });
    }
  });

  return refs;
}

function groupByIssue(refs: readonly BreadcrumbRef[]): Map<number, BreadcrumbRef[]> {
  const grouped = new Map<number, BreadcrumbRef[]>();
  for (const ref of refs) {
    const bucket = grouped.get(ref.issue);
    if (bucket) {
      bucket.push(ref);
    } else {
      grouped.set(ref.issue, [ref]);
    }
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a - b));
}

function shouldSkip(filePath: string): boolean {
  // The self-test fixtures in this file would otherwise report themselves.
  if (filePath === "script/report-breadcrumbs.ts") {
    return true;
  }
  if (EXCLUDED_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) {
    return true;
  }
  return EXCLUDED_PATH_PARTS.some((part) => filePath.includes(part));
}

async function collectSourceFiles(): Promise<string[]> {
  const files = new Set<string>();
  for (const root of SCAN_ROOTS) {
    const glob = new Bun.Glob(`${root}/**/*.ts`);
    for await (const filePath of glob.scan({
      cwd: ".",
      absolute: false,
      dot: false,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      if (!shouldSkip(filePath)) {
        files.add(filePath);
      }
    }
  }
  return Array.from(files).sort((left, right) => left.localeCompare(right));
}

type IssueState = "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";

/**
 * Resolves issue/PR states in one GraphQL round-trip through the local `gh`
 * CLI. Returns null when gh is unavailable, unauthenticated, or offline —
 * callers degrade to the stateless listing.
 */
async function resolveStates(issues: readonly number[]): Promise<Map<number, IssueState> | null> {
  if (issues.length === 0) {
    return new Map();
  }
  const aliases = issues
    .map(
      (issue) =>
        `i${issue}: issueOrPullRequest(number: ${issue}) { __typename ... on Issue { state } ... on PullRequest { state } }`,
    )
    .join("\n");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`;

  try {
    const proc = Bun.spawn(
      ["gh", "api", "graphql", "-f", `query=${query}`, "-F", "owner={owner}", "-F", "name={repo}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) {
      return null;
    }
    const payload = JSON.parse(stdout) as {
      data?: { repository?: Record<string, { state?: string } | null> };
    };
    const repository = payload.data?.repository;
    if (!repository) {
      return null;
    }
    const states = new Map<number, IssueState>();
    for (const issue of issues) {
      const node = repository[`i${issue}`];
      const state = node?.state;
      states.set(
        issue,
        state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : "UNKNOWN",
      );
    }
    return states;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// self-test — synthetic fixtures only
// ---------------------------------------------------------------------------

function selfTest(): void {
  const failures: string[] = [];

  const fixture = [
    "const a = 1; // decided in #510",
    "/**",
    " * See #453 and #510 for the ledger split.",
    " */",
    'const url = "https://example.com/#123"; // no comment ref here except #99 wait, yes',
    'const notAComment = "#777";',
    "/* inline #215 */ const b = 2;",
    "// #1 too short, #21 counts",
  ].join("\n");

  const refs = scanSource("fixture.ts", fixture);
  const grouped = groupByIssue(refs);

  if (!grouped.has(510) || grouped.get(510)?.length !== 2) {
    failures.push(
      `#510 should appear twice (line + block comment), got ${grouped.get(510)?.length ?? 0}`,
    );
  }
  if (!grouped.has(453)) {
    failures.push("#453 in a block-comment continuation line was missed");
  }
  if (!grouped.has(215)) {
    failures.push("#215 in an inline block comment was missed");
  }
  if (!grouped.has(99)) {
    failures.push("#99 after // on a string-bearing line was missed");
  }
  if (grouped.has(123)) {
    failures.push("#123 inside a string URL (before //) was falsely reported");
  }
  if (grouped.has(777)) {
    failures.push("#777 inside a plain string was falsely reported");
  }
  if (grouped.has(1)) {
    failures.push("single-digit #1 should be below the ref threshold");
  }
  if (!grouped.has(21)) {
    failures.push("two-digit #21 was missed");
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`SELF-TEST FAIL: ${failure}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(
    "OK: breadcrumb-report self-test — comment refs extracted, string refs and short refs skipped\n",
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (args.has("--self-test")) {
    selfTest();
    return;
  }

  const files = await collectSourceFiles();
  const refs: BreadcrumbRef[] = [];
  for (const filePath of files) {
    refs.push(...scanSource(filePath, await Bun.file(filePath).text()));
  }
  const grouped = groupByIssue(refs);
  const states = await resolveStates([...grouped.keys()]);

  if (states === null) {
    process.stdout.write(
      "NOTE: gh unavailable/offline — listing refs without issue state (this report never gates CI)\n",
    );
  }

  let closedRefs = 0;
  for (const [issue, occurrences] of grouped) {
    const state = states?.get(issue) ?? "UNKNOWN";
    const marker = state === "CLOSED" || state === "MERGED" ? "PRUNE" : "keep ";
    if (marker === "PRUNE") {
      closedRefs += occurrences.length;
    }
    const label = states === null ? "" : ` [${state}]`;
    process.stdout.write(`${marker} #${issue}${label} — ${occurrences.length} ref(s)\n`);
    for (const ref of occurrences) {
      process.stdout.write(`      ${ref.filePath}:${ref.line}  ${ref.text.slice(0, 120)}\n`);
    }
  }

  process.stdout.write(
    `\n${grouped.size} distinct issue refs, ${refs.length} occurrences across ${files.length} files` +
      (states === null ? "" : `; ${closedRefs} occurrence(s) reference CLOSED/MERGED issues`) +
      "\n",
  );

  if (args.has("--strict") && closedRefs > 0) {
    process.stderr.write(
      `STRICT: ${closedRefs} breadcrumb(s) reference closed issues — prune or rewrite as invariants\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  });
}
