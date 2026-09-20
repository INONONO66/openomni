import { expect, test } from "bun:test";
import { z } from "zod";
import { aggregateFiles, type Audit, type Finding, findingTotals } from "./quality-audit";
import {
  capFiles,
  fileBody,
  ghCommand,
  planIssues,
  previousAudit,
  publishAudit,
  regressions,
} from "./quality-audit-issues";

type Issue = Parameters<typeof planIssues>[1][number];
function audit(findings: Finding[] = []): Audit {
  return {
    version: 1,
    head: "b".repeat(40),
    runUrl: "https://github.com/owner/repo/actions/runs/2",
    generatedAt: "2026-09-20T00:00:00.000Z",
    complete: true,
    missingLanes: [],
    tools: { coverage: "bun", complexity: "biome", clones: "jscpd", types: "census" },
    mutation: "see quality-mutation.yml",
    coverage: [],
    findings,
    totals: findingTotals(findings),
  };
}
function finding(path = "script/a.ts", count = 1): Finding {
  return { path, count, kind: "types", line: 2, message: "site | detail\nnext" };
}
function issue(title: string, number = 1, body = "", state: "open" | "closed" = "open"): Issue {
  return { title, number, body, state, labels: [{ name: "quality-debt" }] };
}
function summary(previous = audit()) {
  const plan = planIssues({ ...previous, head: "a".repeat(40) }, []);
  return issue("quality: audit summary", 99, plan.operations[0]?.body ?? "");
}
function fakeGh(issues: Issue[]) {
  const calls: { args: readonly string[]; input?: string }[] = [];
  const run = (args: readonly string[], input?: string) => {
    calls.push({ args, input });
    if (args[0] === "repo") return Promise.resolve(JSON.stringify({ nameWithOwner: "owner/repo" }));
    if (args.includes("--paginate"))
      return Promise.resolve(JSON.stringify([issues.slice(0, 1), issues.slice(1)]));
    return Promise.resolve(JSON.stringify({ number: 100, id: 100 }));
  };
  return { calls, run };
}

test("first run produces only the summary and round-trippable totals", () => {
  const current = audit([finding()]);
  const plan = planIssues(current, []);
  expect(plan.firstRun).toBe(true);
  expect(plan.skipped).toEqual(["script/a.ts"]);
  expect(plan.operations.map((row) => [row.action, row.title])).toEqual([
    ["create", "quality: audit summary"],
  ]);
  expect(previousAudit(plan.operations[0]?.body ?? "")).toEqual({
    version: 1,
    head: current.head,
    totals: current.totals,
  });
});

test("summary-only bootstrap holds even when unrelated or legacy per-file issues exist", () => {
  expect(planIssues(audit([finding()]), [issue("quality: script/old.ts")]).operations).toHaveLength(
    1,
  );
});

test("cap prioritizes highest counts with deterministic path ties", () => {
  const findings = Array.from({ length: 55 }, (_, index) =>
    finding(`script/${String(index).padStart(2, "0")}.ts`, index + 1),
  );
  const capped = capFiles(audit(findings), []);
  expect(capped.selected).toHaveLength(50);
  expect(capped.selected[0]?.path).toBe("script/54.ts");
  expect(capped.skipped).toEqual([
    "script/04.ts",
    "script/03.ts",
    "script/02.ts",
    "script/01.ts",
    "script/00.ts",
  ]);
  expect(capFiles(audit([finding("b.ts"), finding("a.ts")]), [], 1).selected[0]?.path).toBe("a.ts");
});

test("existing open findings retain their slots, resolved issues free slots", () => {
  const current = audit([finding("old.ts"), finding("worst.ts", 100), finding("skip.ts", 10)]);
  const result = capFiles(current, [issue("quality: old.ts"), issue("quality: resolved.ts", 2)], 2);
  expect(result.selected.map((row) => row.path)).toEqual(["old.ts", "worst.ts"]);
  expect(result.skipped).toEqual(["skip.ts"]);
});

test("upsert updates existing issues, replaces kind labels and preserves manual labels", () => {
  const existing = issue("quality: script/a.ts");
  existing.labels.push({ name: "quality:clones" }, { name: "triaged" });
  const plan = planIssues(audit([finding()]), [summary(), existing]);
  const update = plan.operations.find((row) => row.number === 1);
  expect(update?.action).toBe("update");
  expect(update?.labels).toEqual(["triaged", "quality-debt", "quality:types"]);
  expect(plan.operations.at(-1)?.title).toBe("quality: audit summary");
});

test("resolved per-file issues close, summary and regression issues do not", () => {
  const plan = planIssues(audit(), [
    summary(),
    issue("quality: script/a.ts"),
    issue("quality: regression a..b", 2),
  ]);
  expect(plan.operations.filter((row) => row.action === "close").map((row) => row.number)).toEqual([
    1,
  ]);
});

test("closed file issue is reopened rather than duplicated", () => {
  const plan = planIssues(audit([finding()]), [
    summary(),
    issue("quality: script/a.ts", 1, "", "closed"),
  ]);
  expect(plan.operations.find((row) => row.title === "quality: script/a.ts")?.action).toBe(
    "update",
  );
});

test("regression detection is per kind, including when the total sum shrinks", () => {
  const previous = {
    version: 1 as const,
    head: "a".repeat(40),
    totals: { coverage: 100, complexity: 0, clones: 0, types: 0 },
  };
  expect(regressions(previous, audit([finding()]))).toEqual(["types"]);
  expect(regressions(previous, audit())).toEqual([]);
});

test("regression issue is named by base and head and not duplicated on retry", () => {
  const current = audit([finding()]);
  const title = `quality: regression ${"a".repeat(40)}..${current.head}`;
  const plan = planIssues(current, [summary()]);
  expect(plan.operations.filter((row) => row.title === title)).toHaveLength(1);
  expect(
    planIssues(current, [summary(), issue(title)]).operations.some((row) => row.title === title),
  ).toBe(false);
});

test("history corruption is an error, not a new first run", () => {
  expect(() => previousAudit("no block")).toThrow();
  expect(() => previousAudit("<!-- quality-audit:v1 -->\n```json\n{}\n```")).toThrow();
  expect(() => planIssues(audit(), [issue("quality: audit summary")])).toThrow();
});

test("file body contains machine values, escapes table cells and bounds finding groups", () => {
  const current = audit(Array.from({ length: 101 }, () => finding()));
  const body = aggregateFiles(current.findings)
    .map((file) => fileBody(file, current))
    .join("");
  expect(body).toContain(current.runUrl);
  const rows = body.split("\n").filter((line) => line.startsWith("| types |"));
  expect(rows).toHaveLength(100);
  expect(
    rows[0]
      ?.split(/(?<!\\)\|/)
      .map((part) => part.trim())
      .slice(1, 4),
  ).toEqual(["types", "2", "1"]);
  expect(body.length).toBeLessThan(65_536);
});

test("fake gh first run creates labels and only one issue via JSON", async () => {
  const fake = fakeGh([]);
  const result = await publishAudit(audit([finding()]), fake.run, "owner/repo");
  expect(result.firstRun).toBe(true);
  expect(fake.calls.filter((call) => call.args[0] === "label").map((call) => call.args[2])).toEqual(
    ["quality-debt", "quality:coverage", "quality:complexity", "quality:clones", "quality:types"],
  );
  expect(fake.calls.filter((call) => call.input)).toHaveLength(1);
  const body = z
    .object({ title: z.string(), body: z.string() })
    .parse(JSON.parse(fake.calls.at(-1)?.input ?? "null"));
  expect(body.title).toBe("quality: audit summary");
  expect(previousAudit(body.body).totals.types).toBe(1);
});

test("fake gh pagination, comment-before-close, reopening and summary-last execute together", async () => {
  const fake = fakeGh([
    summary(),
    issue("quality: gone.ts", 1),
    issue("quality: script/a.ts", 2, "", "closed"),
  ]);
  await publishAudit(audit([finding()]), fake.run, "owner/repo");
  const writes = fake.calls.filter((call) => call.input);
  expect(writes[0]?.args).toContain("repos/owner/repo/issues/1/comments");
  expect(writes[1]?.args).toContain("repos/owner/repo/issues/1");
  expect(z.object({ state: z.string() }).parse(JSON.parse(writes[1]?.input ?? "null")).state).toBe(
    "closed",
  );
  expect(writes[2]?.args).toContain("repos/owner/repo/issues/2");
  expect(z.object({ state: z.string() }).parse(JSON.parse(writes[2]?.input ?? "null")).state).toBe(
    "open",
  );
  expect(writes.at(-1)?.args).toContain("repos/owner/repo/issues/99");
});

test("fake gh failures and incomplete evidence never advance summary history", async () => {
  const fake = fakeGh([]);
  await expect(
    publishAudit({ ...audit(), complete: false }, fake.run, "owner/repo"),
  ).rejects.toThrow();
  expect(fake.calls).toHaveLength(0);
  await expect(publishAudit(audit(), () => Promise.resolve("{}"), "owner/repo")).rejects.toThrow();
  const calls: string[] = [];
  await expect(
    publishAudit(
      audit(),
      (args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "label") return Promise.reject(new Error("denied"));
        return Promise.resolve("[[]]");
      },
      "owner/repo",
    ),
  ).rejects.toThrow("denied");
  expect(calls).toEqual(["api", "label"]);
});

test("repository lookup uses parsed gh JSON when not supplied", async () => {
  const fake = fakeGh([]);
  await publishAudit(audit(), fake.run, "");
  expect(fake.calls[0]?.args).toEqual(["repo", "view", "--json", "nameWithOwner"]);
  await expect(publishAudit(audit(), fake.run, "bad/repo/path")).rejects.toThrow();
});

test("gh process boundary sends JSON stdin and surfaces nonzero exits", async () => {
  const text = await ghCommand(
    ["-e", "process.stdout.write(await Bun.stdin.text())"],
    '{"number":12}',
    process.execPath,
  );
  expect(z.object({ number: z.number() }).parse(JSON.parse(text)).number).toBe(12);
  expect(await ghCommand(["-e", "process.stdout.write('{}')"], undefined, process.execPath)).toBe(
    "{}",
  );
  await expect(
    ghCommand(["-e", "console.error('denied');process.exit(3)"], undefined, process.execPath),
  ).rejects.toThrow("exited 3");
});

test("cap refuses an already-overfull managed set instead of opening more", () => {
  const current = audit([finding("a.ts"), finding("b.ts")]);
  const existing = [issue("quality: a.ts"), issue("quality: b.ts", 2)];
  expect(() => capFiles(current, existing, 1)).toThrow();
  const plan = planIssues(current, [
    summary(),
    issue("quality: a.ts", 3, "", "closed"),
    ...existing,
  ]);
  expect(plan.operations.find((row) => row.title === "quality: a.ts")?.number).toBe(1);
});
