import { z } from "zod";
import { aggregateFiles, type Audit, findingKinds, totalsSchema } from "./quality-audit";

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({ name: z.string() })),
});
type Issue = z.infer<typeof issueSchema>;
const previousSchema = z.object({
  version: z.literal(1),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  totals: totalsSchema,
});
type Previous = z.infer<typeof previousSchema>;
const SUMMARY = "quality: audit summary";
const LABELS = ["quality-debt", ...findingKinds.map((kind) => `quality:${kind}`)];
type Operation = {
  action: "create" | "update" | "close";
  title: string;
  body: string;
  labels: string[];
  number?: number;
};
type Gh = (args: readonly string[], input?: string) => Promise<string>;

export function previousAudit(body: string): Previous {
  const block = /<!-- quality-audit:v1 -->\s*```json\s*([\s\S]*?)\s*```/.exec(body);
  if (!block) throw new Error("Summary has no quality-audit totals; refusing to reset history");
  return previousSchema.parse(JSON.parse(block[1] ?? ""));
}

export function regressions(previous: Previous, audit: Audit) {
  return findingKinds.filter((kind) => audit.totals[kind] > previous.totals[kind]);
}

function cell(text: string) {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
}

export function fileBody(file: ReturnType<typeof aggregateFiles>[number], audit: Audit) {
  const rows = file.findings
    .slice(0, 100)
    .map(
      (finding) =>
        `| ${finding.kind} | ${finding.line || "file"} | ${finding.count} | ${cell(finding.message).slice(0, 350)} |`,
    );
  return [
    `Audit: ${audit.runUrl}`,
    `Commit: ${audit.head}`,
    "",
    "| Kind | Line | Count | Finding |",
    "| --- | ---: | ---: | --- |",
    ...rows,
    "",
    `Total: ${file.count}. Showing ${rows.length}/${file.findings.length} finding groups.`,
    "Full evidence: quality-audit.json in the Quality Audit run artifacts.",
  ].join("\n");
}

function upsert(
  title: string,
  body: string,
  labels: string[],
  issues: readonly Issue[],
): Operation {
  const existing =
    issues.find((issue) => issue.title === title && issue.state === "open") ??
    issues.find((issue) => issue.title === title);
  return {
    action: existing ? "update" : "create",
    title,
    body,
    labels: [
      ...new Set([
        ...(existing?.labels.map((label) => label.name).filter((name) => !LABELS.includes(name)) ??
          []),
        ...labels,
      ]),
    ],
    ...(existing ? { number: existing.number } : {}),
  };
}

function fileIssue(issue: Issue) {
  return (
    issue.title.startsWith("quality: ") &&
    issue.title !== SUMMARY &&
    !issue.title.startsWith("quality: regression ")
  );
}

export function capFiles(audit: Audit, issues: readonly Issue[], cap = 50) {
  const files = aggregateFiles(audit.findings);
  const open = new Set(
    issues
      .filter((issue) => issue.state === "open" && fileIssue(issue))
      .map((issue) => issue.title.slice(9)),
  );
  const retained = files.filter((file) => open.has(file.path));
  if (retained.length > cap) throw new Error(`Existing per-file issues exceed cap ${cap}`);
  const selected = [
    ...retained,
    ...files.filter((file) => !open.has(file.path)).slice(0, cap - retained.length),
  ];
  const paths = new Set(selected.map((file) => file.path));
  return {
    selected,
    skipped: files.filter((file) => !paths.has(file.path)).map((file) => file.path),
  };
}

function summaryBody(audit: Audit, skipped: readonly string[], firstRun: boolean) {
  const files = aggregateFiles(audit.findings);
  return [
    `Audit: ${audit.runUrl}`,
    `Complete: ${audit.complete}; first run: ${firstRun}`,
    "",
    "| Kind | Total findings |",
    "| --- | ---: |",
    ...findingKinds.map((kind) => `| ${kind} | ${audit.totals[kind]} |`),
    "",
    `Mutation: see [quality-mutation.yml](${audit.runUrl.split("/").slice(0, 5).join("/")}/actions/workflows/quality-mutation.yml).`,
    "",
    "Totals count uncovered executable lines (or one missing-file record), complex functions, clone endpoints, and type sites.",
    "Coverage denominators and all findings are in the quality-audit.json run artifact. Missing source records are not zero coverage debt.",
    "",
    "## Highest finding counts",
    "| File | Count |",
    "| --- | ---: |",
    ...files.slice(0, 50).map((file) => `| ${cell(file.path)} | ${file.count} |`),
    "",
    "## Skipped per-file issues",
    ...(skipped.length ? skipped.map((path) => `- ${cell(path)}`) : ["None."]),
    "",
    "<!-- quality-audit:v1 -->",
    "```json",
    JSON.stringify({ version: 1, head: audit.head, totals: audit.totals }),
    "```",
  ].join("\n");
}

export function planIssues(audit: Audit, issues: readonly Issue[]) {
  const summary = issues.find((issue) => issue.title === SUMMARY);
  const firstRun = !summary;
  const selection = summary
    ? capFiles(audit, issues)
    : { selected: [], skipped: aggregateFiles(audit.findings).map((file) => file.path) };
  const skipped = selection.skipped;
  const operations: Operation[] = [];
  if (summary) {
    const currentPaths = new Set(audit.findings.map((finding) => finding.path));
    for (const issue of issues.filter((row) => row.state === "open" && fileIssue(row))) {
      if (!currentPaths.has(issue.title.slice(9)))
        operations.push({
          action: "close",
          number: issue.number,
          title: issue.title,
          body: `No findings in the current audit: ${audit.runUrl}`,
          labels: [],
        });
    }
    for (const file of selection.selected)
      operations.push(
        upsert(
          `quality: ${file.path}`,
          fileBody(file, audit),
          ["quality-debt", ...new Set(file.findings.map((finding) => `quality:${finding.kind}`))],
          issues,
        ),
      );
    const previous = previousAudit(summary.body ?? "");
    const increased = regressions(previous, audit);
    const title = `quality: regression ${previous.head}..${audit.head}`;
    if (increased.length && !issues.some((issue) => issue.title === title))
      operations.push(
        upsert(
          title,
          [
            `Audit: ${audit.runUrl}`,
            "",
            "| Kind | Previous | Current |",
            "| --- | ---: | ---: |",
            ...increased.map(
              (kind) => `| ${kind} | ${previous.totals[kind]} | ${audit.totals[kind]} |`,
            ),
          ].join("\n"),
          ["quality-debt"],
          issues,
        ),
      );
  }
  // Advance history last, so a failed publication can be safely retried against the same base.
  operations.push(upsert(SUMMARY, summaryBody(audit, skipped, firstRun), ["quality-debt"], issues));
  return { firstRun, skipped, operations };
}

export async function ghCommand(args: readonly string[], input?: string, executable = "gh") {
  const child = Bun.spawn([executable, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}

async function apply(operation: Operation, endpoint: string, run: Gh) {
  if (operation.action === "close") {
    await run(
      ["api", "--method", "POST", `${endpoint}/${operation.number}/comments`, "--input", "-"],
      JSON.stringify({ body: operation.body }),
    );
    await run(
      ["api", "--method", "PATCH", `${endpoint}/${operation.number}`, "--input", "-"],
      JSON.stringify({ state: "closed", state_reason: "completed" }),
    );
    return;
  }
  const target = operation.number ? `${endpoint}/${operation.number}` : endpoint;
  const result = await run(
    ["api", "--method", operation.number ? "PATCH" : "POST", target, "--input", "-"],
    JSON.stringify({
      title: operation.title,
      body: operation.body,
      labels: operation.labels,
      ...(operation.number ? { state: "open" } : {}),
    }),
  );
  z.object({ number: z.number().int().positive() }).parse(JSON.parse(result));
}

export async function publishAudit(
  audit: Audit,
  run: Gh = ghCommand,
  repository = process.env.GITHUB_REPOSITORY ?? "",
) {
  if (!audit.complete) throw new Error("Refusing to publish incomplete audit");
  const repo =
    repository ||
    z
      .object({ nameWithOwner: z.string() })
      .parse(JSON.parse(await run(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  const endpoint = `repos/${repo}/issues`;
  const response = await run([
    "api",
    "--paginate",
    "--slurp",
    `${endpoint}?state=all&labels=quality-debt&per_page=100`,
  ]);
  const issues = z.array(z.array(issueSchema)).parse(JSON.parse(response)).flat();
  const plan = planIssues(audit, issues);
  for (const label of LABELS)
    await run(["label", "create", label, "--repo", repo, "--color", "D4C5F9", "--force"]);
  for (const operation of plan.operations) await apply(operation, endpoint, run);
  return plan;
}
