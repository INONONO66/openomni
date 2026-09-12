import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyExecution, removeExecution, decode, execute, executionTreeHash, main, mutationSource, sha256 } from "./run-quality-mutations";
import { mutationFixture, mutationEvidence, replaceArguments, reportResults } from "./quality-mutation-fixture";
import { buildInventory, readContract } from "./quality-inventory";
import { analyze, enumerate, programs, diagnostics, failedAssertions } from "./run-quality-mutations";
import { tmpdir } from "node:os";

test("assertion receipt parsing separates matcher failures from crashes and other testcases", () => {
	const stderr = [
		"src/a.test.ts:", "error: expect(received).toBe(expected)", "(fail) matcher [1ms]",
		"error: expect(received).not.toEqual(expected)", "(pass) passing [1ms]",
		"Error: crash", "(fail) crash [1ms]",
		"error: expect(received).toBe(expected)", "Error: another crash", "(fail) mixed [1ms]",
		"error:", "Expected promise that rejects", "Received promise that resolved:", "(fail) settlement [1ms]",
		"::group::src/b.test.ts:", "(fail) without diagnostic [1ms]",
		"error: expect(received).resolves.toBe(expected)", "(fail) second-file [1ms]",
	].join("\n");
	expect(failedAssertions(stderr)).toEqual([
		"src/a.test.ts\0matcher", "src/a.test.ts\0settlement", "src/b.test.ts\0second-file",
	]);
	expect(failedAssertions("")).toEqual([]);
});

test("mutation helpers cover execution tree recursion and virtual source traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-tree-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "source.ts"), "export const value = 1;");
    symlinkSync("nested/source.ts", join(root, "source-link.ts"));
    expect(executionTreeHash(root)).toHaveLength(64);
    symlinkSync("/tmp", join(root, "external-link.ts"));
    expect(() => executionTreeHash(root)).toThrow();
    const source = mutationSource(resolve(import.meta.dir, ".."), "script/run-quality-mutations.ts");
    expect(source.source).toContain("export async function main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("process receipts preserve executed failure context, including signals", async () => {
  const failed = await execute([process.execPath, "-e", "process.stderr.write('candidate failed'); process.exit(7)"], process.cwd(), 5000, {}, "candidate-test");
  expect(failed.stage).toBe("candidate-test");
  expect(failed.argv).toEqual([process.execPath, "-e", "process.stderr.write('candidate failed'); process.exit(7)"]);
  expect(failed.exitCode).toBe(7);
  expect(failed.signal).toBeNull();
  expect(failed.stderr).toBe("candidate failed");
  expect(failed.stderrSha256).toBe(sha256("candidate failed"));
  const redacted = await execute([process.execPath, "-e", "process.exit(3)", "--token=inline-secret", "--name", "public"], process.cwd(), 5000, {}, "redaction-test");
  expect(redacted.argv).toEqual([process.execPath, "-e", "process.exit(3)", "--token=[redacted]", "--name", "public"]);
  expect(JSON.stringify(redacted)).not.toContain("inline-secret");
  const signaled = await execute([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"], process.cwd(), 5000, {}, "signal-test");
  expect(signaled.stage).toBe("signal-test");
  expect(signaled.exitCode).toBeNull();
  expect(signaled.signal).toBe("SIGTERM");
  expect(signaled.stderrSha256).toBe(sha256(signaled.stderr));
});

test("mutation main rejects an invalid invocation in process", async () => {
  expect(await main(["--not-a-real-option"])).toBe(2);
});
const { fixture, invoke, select, assertBehavioralKill, record, rows, evidence, tool, decision, runner, FixtureError } = mutationFixture("campaign");
type RecordValue = ReturnType<typeof record>;

test("rendered process receipts redact split and inline secrets without hiding ordinary arguments", async () => {
  const command = [process.execPath, "-e", "process.exit(7)", "--"];
  const ordinary = ["--name", "public", "--monkey=banana", "--key-file=public.pem", "--tokenizer", "native"];
  const secrets = ["inline-key-secret", "split-key-secret", "inline-token-secret", "split-token-secret", "api-key-secret"];
  const receipt = await execute([...command,
    `--key=${secrets[0]}`, "--key", secrets[1] ?? "", ...ordinary,
    `--token=${secrets[2]}`, "--token", secrets[3] ?? "", ...ordinary,
    `--api-key=${secrets[4]}`, ...ordinary,
  ], process.cwd(), 5000, {}, "redaction-test");
  expect(receipt.exitCode).toBe(7);
  const rendered = JSON.stringify(receipt);
  expect(record(decode(rendered)).argv).toEqual([...command,
    "--key=[redacted]", "--key", "[redacted]", ...ordinary,
    "--token=[redacted]", "--token", "[redacted]", ...ordinary,
    "--api-key=[redacted]", ...ordinary,
  ]);
  for (const secret of secrets) expect(rendered).not.toContain(secret);
});

for (const mode of ["nonzero", "signal"] as const) {
  test(`top-level setup failure propagates ${mode} process context and redacts rendered diagnostics`, async () => {
    const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
    const worker = join(input.root, "canonical-worker.ts");
    const stdout = "worker-started\n";
    const stderr = "setup worker failed: --key=inline-key-secret --token split-token-secret --name public\n";
    const safeStderr = "setup worker failed: --key=[redacted] --token [redacted] --name public\n";
    writeFileSync(worker, `import {writeFileSync} from "node:fs";
      writeFileSync(1, ${JSON.stringify(stdout)});
      writeFileSync(2, ${JSON.stringify(stderr)});
      ${mode === "nonzero" ? "process.exit(7);" : 'process.kill(process.pid, "SIGTERM");'}`);
    const result = await invoke(input, `setup-${mode}`, select("boolean-literal"), [
      "--inventory-tool", worker, "--inventory-tool-sha256", sha256(readFileSync(worker)),
    ]);
    expect(result.code).toBe(2);
    expect(result.report.complete).toBe(false);
    expect(result.report.results).toBeUndefined();
    expect(result.selected).toHaveLength(0);
    const error = record(result.report.error);
    expect(error.code).toBe("incompleteInventory");
    const receipt = record(error.process);
    expect(receipt.stage).toBe("setup-canonical-inventory");
    expect(receipt.argv).toEqual([
      process.execPath, worker, "--root", realpathSync(input.root), "--contract", join(input.root, "contract.json"), "--inventory", input.inventory,
    ]);
    expect(receipt.exitCode).toBe(mode === "nonzero" ? 7 : null);
    expect(receipt.signal).toBe(mode === "signal" ? "SIGTERM" : null);
    expect(receipt.timedOut).toBe(false);
    expect(receipt.spawnError).toBe(false);
    expect(receipt.overflow).toBe(false);
    expect(receipt.stdout).toBe(stdout);
    expect(receipt.stdoutSha256).toBe(sha256(stdout));
    expect(receipt.stderr).toBe(safeStderr);
    expect(receipt.stderrSha256).toBe(sha256(stderr));
    // The CLI JSON is decoded by invoke; inspect its complete machine-consumed
    // envelope, not only the execute() helper or the process subobject.
    const rendered = JSON.stringify(result.report);
    expect(rendered).not.toContain("inline-key-secret");
    expect(rendered).not.toContain("split-token-secret");
  }, 90000);
}

test("fixture argument replacement is pure and rejects incomplete pairs", () => {
  const argv = ["runner", "--root", "before", "--limit", "1"];
  expect(replaceArguments(argv, ["--root", "after", "--limit", "2"])).toEqual(["runner", "--root", "after", "--limit", "2"]);
  expect(argv[2]).toBe("before");
  expect(replaceArguments(argv, [])).toEqual(argv);
  for (const alter of [["--root"], ["", "value"], ["--root", ""]]) expect(() => replaceArguments(argv, alter)).toThrow();
});

test("fixture report processing validates candidate counts hashes and reached outcomes in process", () => {
  const replacement = "false", replacementSha256 = sha256(replacement);
  const results = ["killed", "survived", "noCoverage", "invalid"].map((outcome, startOffset) => ({
    path: "src/a.ts", startOffset, endOffset: startOffset + 1, replacement, replacementSha256,
    id: sha256(`src/a.ts\0${startOffset}\0${startOffset + 1}\0${replacementSha256}`),
    selected: true, outcome, coverage: { reached: outcome !== "noCoverage" },
  }));
  const report = { results, census: [{ path: "src/a.ts", operators: [{ candidates: 4 }] }], counts: { killed: 1, survived: 1, noCoverage: 1, invalid: 1 } };
  expect(reportResults(report)).toEqual(results);
  expect(reportResults({})).toEqual([]);
  expect(reportResults({ ...report, results: results.map((row) => ({ ...row, selected: false })) })).toEqual([]);
  for (const patch of [
    { counts: { killed: 2 } }, { census: [{ path: "src/a.ts", operators: [{ candidates: 3 }] }] },
    { results: results.map((row) => ({ ...row, replacementSha256: "wrong" })) },
    { results: results.map((row) => ({ ...row, id: "wrong" })) },
    { results: results.map((row) => ({ ...row, coverage: { reached: false } })) },
    { results: results.map((row) => ({ ...row, coverage: { reached: true } })) },
  ]) expect(() => reportResults({ ...report, ...patch })).toThrow();
});

test("fixture evidence preserves present fields and materializes missing fields as null", () => {
  const report = { full: false, complete: true, counts: {}, selectedCounts: {}, error: "failure", errors: [], cleanupVerified: true };
  const selected = { id: "id", operator: "equality", outcome: "killed", reason: "assertion", assertionIdentities: ["test"], restored: false };
  expect(mutationEvidence(report, [selected])).toEqual({ ...report, report, selected: [selected] });
  const empty = mutationEvidence({}, [{}]);
  expect(empty.full).toBeNull();
  expect(rows(empty.selected).map(record)[0]).toEqual({ id: null, operator: null, outcome: null, reason: null, assertionIdentities: null, restored: null });
  for (const value of [undefined, null, false, [], "invalid"]) expect(() => record(value)).toThrow();
  for (const value of [undefined, null, {}, "invalid"]) expect(() => rows(value)).toThrow();
});

test("campaign runs baseline, mutant, restoration and JSON receipt in process", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/other/package.json": '{"name":"other","type":"module"}',
		"src/other/extra.test.ts": 'import {test,expect} from "bun:test";test("isolated package",()=>expect(process.cwd().endsWith("other")).toBe(true));',
	});
	fixtureGit(input.root, "init", "-q");
	fixtureGit(input.root, "add", ".");
	fixtureGit(input.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
	const external = await invoke(input, "in-process-reference", select("boolean-literal"));
	assertBehavioralKill(external);
	const argv = rows(evidence.at(-1)?.argv).map(String).slice(2);
	const output: string[] = [];
	const log: (value: string) => void = console.log;
	console.log = (value: string) => { output.push(value); };
	try {
		expect(await main(argv)).toBe(0);
		const report = record(decode(output.join("")));
		expect(report.complete).toBe(true);
		expect(report.cleanupVerified).toBe(true);
		expect(report.originalHashesVerified).toBe(true);
		expect(report.selectedCounts).toEqual(external.report.selectedCounts);
		const batches = rows(record(report.baseline).batches).map(record);
		expect(batches).toHaveLength(2);
		expect(batches.every((batch) => record(batch.process).timedOut === false)).toBe(true);
		expect(reportResults(report)[0]?.outcome).toBe("killed");
	} finally { console.log = log; }
}, 90000);

test("sequential compiler analysis preserves first-owner candidates and complete census", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/driver.py": "print(True)",
	});
	const contract = readContract(join(input.root, "contract.json"));
	contract.projects.push(...contract.projects);
	const inventory = buildInventory(input.root, contract);
	const operators = [{ id: "boolean-literal", replacements: new Map<string, string[]>() }];
	const eager = [...programs(input.root, contract, inventory)];
	const expected = enumerate(input.root, inventory, operators, eager);
	const actual = analyze(input.root, contract, inventory, operators);
	expect(actual.enumerated).toEqual(expected);
	expect(actual.sourceDiagnostics).toEqual(diagnostics(eager));
	expect(actual.enumerated.candidates.length).toBeGreaterThan(0);
}, 90000);

function fixtureGit(root: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

test("execution worktrees retain Git history, dirty inputs, dependencies and isolated indexes", () => {
	const root = mkdtempSync(join(tmpdir(), "mutation-git-"));
	const copy = join(root, "copy"), nested = join(root, "nested"), source = join(root, "source");
	mkdirSync(source);
	try {
		fixtureGit(source, "init", "-q");
		writeFileSync(join(source, "tracked.ts"), "export const value = true;");
		fixtureGit(source, "add", ".");
		fixtureGit(source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
		const head = fixtureGit(source, "rev-parse", "HEAD");
		writeFileSync(join(source, "tracked.ts"), "export const value = false;");
		mkdirSync(join(source, "node_modules/dep/dist"), { recursive: true });
		writeFileSync(join(source, "node_modules/dep/dist/index.js"), "export const value = 1;");
		copyExecution(source, copy);
		copyExecution(copy, nested);
		expect(fixtureGit(nested, "rev-parse", "HEAD")).toBe(head);
		expect(fixtureGit(nested, "log", "-1", "--format=%s")).toBe("fixture");
		expect(fixtureGit(nested, "ls-files")).toBe("tracked.ts");
		expect(readFileSync(join(nested, "tracked.ts"), "utf8")).toBe("export const value = false;");
		expect(readFileSync(join(nested, "node_modules/dep/dist/index.js"), "utf8")).toBe("export const value = 1;");
		const hash = executionTreeHash(copy);
		writeFileSync(join(nested, "tracked.ts"), "mutant");
		fixtureGit(nested, "add", "tracked.ts");
		expect(fixtureGit(source, "diff", "--cached")).toBe("");
		expect(executionTreeHash(copy)).toBe(hash);
		removeExecution(nested);
		removeExecution(copy);
		expect(fixtureGit(source, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(existsSync(copy)).toBe(false);
		expect(existsSync(nested)).toBe(false);
	} finally {
		removeExecution(nested);
		removeExecution(copy);
		rmSync(root, { recursive: true, force: true });
	}
});

test("execution snapshots retain isolated workspace dependencies and built exports", async () => {
	const input = await fixture('import { value } from "workspace-dep"; export const run = () => value === 7;', "expect(run()).toBe(true);");
	mkdirSync(join(input.root, "vendor/dep/dist"), { recursive: true });
	mkdirSync(join(input.root, "src/node_modules"), { recursive: true });
	writeFileSync(join(input.root, "vendor/dep/package.json"), JSON.stringify({ name: "workspace-dep", type: "module", exports: "./dist/index.js" }));
	writeFileSync(join(input.root, "vendor/dep/dist/index.js"), "export const value = 7;");
	writeFileSync(join(input.root, "vendor/dep/dist/index.d.ts"), "export declare const value: number;");
	symlinkSync("../../vendor/dep", join(input.root, "src/node_modules/workspace-dep"));
	// A real workspace back-edge must remain internal, without recursive copying.
	mkdirSync(join(input.root, "vendor/dep/node_modules"));
	symlinkSync("../../../src", join(input.root, "vendor/dep/node_modules/app"));
	const result = await invoke(input, "workspace-layout", select("equality"));
	assertBehavioralKill(result);
	expect(result.report.sourceDiagnostics).toEqual([]);
	expect(result.report.cleanupVerified).toBe(true);
	expect(readFileSync(join(input.root, "vendor/dep/dist/index.js"), "utf8")).toBe("export const value = 7;");
}, 90000);

test("review R2: negated assertion is a behavioral kill", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).not.toBe(false);");
	const result = await invoke(input, "review-negated", select("boolean-literal"));
	assertBehavioralKill(result);
}, 90000);

test("review R3: optional method preserves its receiver", async () => {
	const input = await fixture(
		"const value = { n: 3, method() { return this.n; } }; export const run = () => value?.method();",
		"expect(run()).toBe(3);",
	);
	const result = await invoke(input, "review-receiver", select("optional-chain"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("survived");
}, 90000);

test("weak assertion survives; original location is really covered", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(typeof run()).toBe("boolean");',
	);
	const result = await invoke(input, "survivor", select("boolean-literal"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("survived");
}, 90000);

test("same-site replacements reuse one original probe and preserve candidate receipts", async () => {
	const input = await fixture(
		"export const run = (n:number) => n < 2;",
		"expect(run(1)).toBe(true);",
	);
	const result = await invoke(input, "same-site-reuse", ["--target", "src/a.ts", "--operator", "relational", "--limit", "2"]);
	expect(result.code).toBe(1);
	expect(result.selected).toHaveLength(2);
	expect(new Set(result.selected.map((row) => String(row.id))).size).toBe(2);
	expect(result.selected.every((row) => ["killed", "survived"].includes(String(row.outcome)) && row.restored === true)).toBe(true);
	// Each candidate is compiler-checked once. With one test batch, the first
	// candidate has compiler + probe + mutation receipts; the second has only
	// compiler + mutation. Without reuse this would be [3, 3], not [3, 2].
	expect(result.selected.map((row) => rows(row.receipts).length)).toEqual([3, 2]);
}, 90000);

test("same-line distinct Sites do not share original probes", async () => {
	const input = await fixture(
		"export const run = () => true && false;",
		"expect(run()).toBe(false);",
	);
	const result = await invoke(input, "same-line-distinct-sites", ["--target", "src/a.ts", "--operator", "boolean-literal", "--limit", "2"]);
	expect(result.code).toBe(1);
	expect(result.selected).toHaveLength(2);
	expect(new Set(result.selected.map((row) => String(row.id))).size).toBe(2);
	expect(result.selected.every((row) => row.restored === true)).toBe(true);
	// Each distinct site has its own compiler, probe, and mutation receipts.
	expect(result.selected.map((row) => rows(row.receipts).length)).toEqual([3, 3]);
}, 90000);

test("uninvoked function is noCoverage, not survived", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(typeof run).toBe("function");',
	);
	const result = await invoke(input, "noCoverage", select("boolean-literal"));
	expect(result.code).toBe(1);
	expect(result.selected[0]?.outcome).toBe("noCoverage");
}, 90000);

test("compiler rejection stays invalid and cannot make an all-invalid run green", async () => {
	const input = await fixture("export const run = ():true => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "invalid", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("invalid");
	expect(record(result.report.counts).killed).toBe(0);
	expect(rows(result.selected[0]?.receipts)).toHaveLength(1);
}, 90000);

test("crash after a successful assertion is infrastructure despite Bun JUnit label", async () => {
	const input = await fixture(
		"export const run = () => true;",
		'expect(1).toBe(1);if(!run())throw new Error("crash-not-assertion");',
	);
	const result = await invoke(input, "crash-after-assertion", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
	expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(0);
	expect(result.report.error).toBeUndefined();
	expect(result.selected[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	const receipt = rows(result.selected[0]?.receipts).map(record).at(-1);
	expect(receipt?.exitCode).toBe(1);
	expect(receipt?.signal).toBeNull();
	expect(receipt?.stderr).toContain("crash-not-assertion");
	expect(receipt?.stderrSha256).toBe(sha256(String(receipt?.stderr)));
}, 90000);

test("GitHub grouped diagnostics preserve kills without promoting crashes", async () => {
	const previous = process.env.GITHUB_ACTIONS;
	process.env.GITHUB_ACTIONS = "true";
	try {
		for (const [assertion, outcome, code] of [
			["expect(run()).toBe(true);", "killed", 0],
			['expect(1).toBe(1);if(!run())throw new Error("crash-not-assertion");', "infrastructure", 2],
		] as const) {
			const input = await fixture("export const run = () => true;", assertion);
			const result = await invoke(input, `github-${outcome}`, select("boolean-literal"));
			expect(result.code).toBe(code);
			expect(result.selected[0]?.outcome).toBe(outcome);
			expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(code === 0 ? 1 : 0);
		}
	} finally {
		if (previous === undefined) delete process.env.GITHUB_ACTIONS;
		else process.env.GITHUB_ACTIONS = previous;
	}
}, 90000);

test("bounded mutant hang is infrastructure, not killed", async () => {
	const input = await fixture(
		"export const run = () => true;",
		"if(!run()){while(true){}}expect(run()).toBe(true);",
	);
	const result = await invoke(input, "timeout", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
	expect(result.selected[0]?.typecheck).toBe("valid");
	expect(result.selected[0]?.reason).toBe("failure-without-complete-behavioral-assertions");
	expect(rows(result.selected[0]?.receipts).map(record).at(-1)?.timedOut).toBe(true);
}, 90000);

test("exhausted budget accounts every candidate as uncompleted", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "budget", ["--budget", "1"]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
	expect(result.selected.every((row) => row.outcome === "uncompleted")).toBe(true);
	expect(result.selected.length).toBeGreaterThan(0);
}, 90000);

test("work budget cannot silently turn an unfinished full run into a selected pass", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "max-candidates", ["--max-candidates", "1"]);
	expect(result.code).toBe(2);
	expect(result.selected.length).toBeGreaterThan(1);
	expect(result.selected.filter((row) => row.outcome !== "uncompleted")).toHaveLength(1);
	expect(result.report.full).toBe(false);
}, 90000);

test("a same-name replacement contract cannot weaken the frozen operators", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const changed = record(decode(readFileSync(decision, "utf8")));
	const contract = record(changed.contract);
	const mutation = record(contract.mutation);
	const operators = rows(mutation.operators).map((value, index) =>
		index === 0 ? { ...record(value), replacements: { true: ["true"], false: ["false"] } } : value,
	);
	const path = join(input.root, "changed-decision.json");
	writeFileSync(
		path,
		JSON.stringify({ ...changed, contract: { ...contract, mutation: { ...mutation, operators } } }),
	);
	const result = await invoke(input, "weakened-operators", select("boolean-literal"), [
		"--decision",
		path,
		"--decision-sha256",
		sha256(readFileSync(path)),
	]);
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("operatorContract");
}, 90000);

test("JSON schema errors do not reach test execution", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	writeFileSync(input.inventory, '{"version":2}');
	const result = await invoke(input, "invalid-schema", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("schema");
}, 90000);

test("candidate identity and AST census are deterministic across isolated copies", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const first = await invoke(input, "determinism-first", select("boolean-literal"));
	const second = await invoke(input, "determinism-second", select("boolean-literal"));
	expect(first.code).toBe(0);
	expect(second.code).toBe(0);
	const identity = (row: RecordValue) => ({
		id: row.id,
		path: row.path,
		start: row.startOffset,
		end: row.endOffset,
		operator: row.operator,
		replacement: row.replacement,
		outcome: row.outcome,
	});
	expect(first.selected.map(identity)).toEqual(second.selected.map(identity));
	expect(first.report.census).toEqual(second.report.census);
	expect(first.report.executionTreeSha256).toBe(second.report.executionTreeSha256);
}, 90000);

test("probe side effects cannot contaminate the fresh mutation copy", async () => {
	const input = await fixture(
		"export const run = (n:number) => n+1;",
		'const fs=await import("node:fs");if(fs.existsSync("state"))throw new Error("leaked-state");fs.writeFileSync("state","created");expect(run(1)).toBe(2);',
	);
	const result = await invoke(input, "isolated-snapshots", select("arithmetic"));
	expect(result.code).toBe(0);
	expect(result.selected[0]?.outcome).toBe("killed");
	expect(existsSync(join(input.root, "state"))).toBe(false);
}, 90000);

test("unfiltered execution includes mutations of tests and cannot claim global zero", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "full-census");
	expect(result.report.full).toBe(true);
	expect(record(result.report.counts).uncompleted).toBe(0);
	expect(result.selected.some((row) => row.path === "src/a.test.ts")).toBe(true);
	expect(result.selected.some((row) => row.outcome === "survived")).toBe(true);
	expect(result.code).not.toBe(0);
}, 90000);

test("frozen inventory omission is an analysis error from canonical verifier", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	writeFileSync(join(input.root, "src/unlisted.ts"), "export const omitted = 3;");
	const result = await invoke(input, "incomplete-inventory", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("incompleteInventory");
}, 90000);

test("tampered frozen input cannot pass with stale hash", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "tamper", select("boolean-literal"), [
		"--inventory-sha256",
		"0".repeat(64),
	]);
	expect(result.code).toBe(2);
	expect(record(result.report.error).code).toBe("tamper");
}, 90000);

test("malformed Python input remains enumerated and blocks execution", async () => {
	const input = await fixture("export const run = () => true;", "expect(run()).toBe(true);", {
		"src/driver.py": "def run(:\n    return True\n",
	});
	const result = await invoke(input, "malformed-python", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(
		rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/driver.py")?.syntax,
	).toBe("python-analysis-error");
	expect(result.report.full).toBe(false);
}, 90000);

test("invalid TS syntax does not become a behavioral kill", async () => {
	const input = await fixture("export const run = ( => true;", "expect(run()).toBe(true);");
	const result = await invoke(input, "unsupported-ts-syntax", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(
		rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/a.ts")?.syntax,
	).toBe("unsupportedSyntax");
}, 90000);

test("missing CLI input and baseline growth flags are analysis errors", async () => {
	for (const args of [[], ["--update", "true"]]) {
		const result = await execute([process.execPath, runner, ...args], import.meta.dir, 15000);
		const report = record(decode(result.stdout));
		expect(result.exitCode).toBe(2);
		expect(report.complete).toBe(false);
		evidence.push({
			name: args.length ? "reject-update" : "missing-input",
			exitCode: result.exitCode,
			error: report.error ?? null,
		});
	}
});

test("typed JSON boundary rejects executable syntax and duplicate keys", () => {
	for (const value of ['{"a":true,"a":false}', '{"a":undefined}', '{"a":()=>1}'])
		expect(() => decode(value)).toThrow();
	expect(decode('{"a":[true,null,-2,"unknown any"]}')).toEqual({
		a: [true, null, -2, "unknown any"],
	});
});

for (const assertion of [
	'await expect(run()?Promise.reject(new Error("expected")):Promise.resolve(3)).rejects.toBeInstanceOf(Error);',
	'await expect(run()?Promise.resolve(3):Promise.reject(new Error("mutated"))).resolves.toBe(3);',
])
	test("wrong promise settlement is a genuine assertion failure", async () => {
		const input = await fixture("export const run=()=>true;", assertion);
		const result = await invoke(input, "promise-settlement", select("boolean-literal"));
		assertBehavioralKill(result);
	}, 90000);

test("passing self-closing JUnit cases cannot steal a grouped failure identity", async () => {
	const input = await fixture("export const run=()=>true;", "", {
		"src/a.test.ts":
			'import {describe,test,expect} from "bun:test";import {run} from "./a";test("first passing",()=>{expect(1).toBe(1);});describe("group",()=>{test("behavior",()=>{expect(run()).not.toBe(false);});});',
	});
	const result = await invoke(input, "grouped-negated", select("boolean-literal"));
	expect(result.code).toBe(0);
	const identities = rows(result.selected[0]?.assertionIdentities);
	expect(identities).toHaveLength(1);
	expect(record(decode(String(identities[0]))).name).toBe("behavior");
}, 90000);

test("canonical TS and JS outside native includes get inventory fallback ownership", async () => {
	const input = await fixture("export const run=()=>true;", "expect(run()).toBe(true);", {
		"src/excluded/loose.ts": "export const loose=()=>true;",
		"src/excluded/loose.js": "export const loose=()=>true;",
	});
	const config = join(input.root, "src/tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({ ...record(decode(readFileSync(config, "utf8"))), exclude: ["excluded"] }),
	);
	const generated = await execute(
		[process.execPath, tool, "--root", input.root, "--contract", join(input.root, "contract.json")],
		input.root,
		15000,
	);
	expect(generated.exitCode).toBe(0);
	writeFileSync(input.inventory, generated.stdout);
	const result = await invoke(input, "inventory-fallback", select("boolean-literal"));
	expect(result.code).toBe(0);
	for (const path of ["src/excluded/loose.ts", "src/excluded/loose.js"]) {
		const row = rows(result.report.census)
			.map(record)
			.find((item) => item.path === path);
		expect(row?.syntax).toBe("parsed");
		expect(
			rows(row?.operators)
				.map(record)
				.find((op) => op.operator === "boolean-literal")?.candidates,
		).toBe(1);
	}
}, 90000);

test("assertion identity cannot credit another testcase's crash", async () => {
	const input = await fixture("export const run=()=>true;", "expect(run()).not.toBe(false);", {
		"src/crash.test.ts":
			'import {test,expect} from "bun:test";import {run} from "./a";test("separate crash",()=>{expect(1).toBe(1);if(!run())throw new Error("crash");});',
	});
	const result = await invoke(input, "mixed-assertion-crash", select("boolean-literal"));
	expect(result.code).toBe(2);
	expect(result.selected[0]?.outcome).toBe("infrastructure");
}, 90000);

test("missing executable reports infrastructure without leaking resources", async () => {
	const result = await execute(["/not/a/real/executable"], import.meta.dir, 1000);
	expect(result.spawnError).toBe(true);
	expect(result.exitCode).not.toBe(0);
	expect(result.timedOut).toBe(false);
	expect(existsSync("/not/a/real/executable")).toBe(false);
});

const pythonEntry =
	'export async function run(){const child=Bun.spawn(["python3","src/driver.py"],{stdout:"pipe",stderr:"pipe"}); const output=await new Response(child.stdout).text(); const error=await new Response(child.stderr).text(); const exit=await child.exited; if(exit!==0)throw new Error(error); return output.trim();}';
const pythonFamilies = [
	{ id: "py-boolean", code: "print(True)", output: "True" },
	{ id: "py-equality", code: "print(1 == 1)", output: "True" },
	{ id: "py-relational", code: "print(1 < 1)", output: "False" },
	{ id: "py-arithmetic", code: "print(2 + 1)", output: "3" },
	{ id: "py-logical", code: "print(True and False)", output: "False" },
	{ id: "py-unary", code: "print(not True)", output: "False" },
	{ id: "py-number", code: "print(42)", output: "42" },
	{ id: "py-string", code: "print('hello')", output: "hello" },
	{ id: "py-condition", code: "print(1 if 1 else 2)", output: "1" },
	{ id: "py-expression-delete", code: "print('hello')", output: "hello" },
	{ id: "py-return", code: "def run():\n    return 42\nprint(run())", output: "42" },
	{
		id: "py-raise",
		code: "try:\n    raise ValueError('boom')\nexcept ValueError:\n    print('raised')",
		output: "raised",
	},
	{ id: "py-container", code: "print([1, 2])", output: "[1, 2]" },
	{
		id: "py-assert",
		code: "try:\n    assert False\nexcept AssertionError:\n    print('asserted')",
		output: "asserted",
	},
	{
		id: "py-await",
		code: "import asyncio\nasync def inner():\n    return 3\nasync def run():\n    result = await inner()\n    return type(result).__name__\nprint(asyncio.run(run()))",
		output: "int",
	},
];
for (const family of pythonFamilies)
	test(`real Python operator seam: ${family.id}`, async () => {
		const input = await fixture(
			pythonEntry,
			`expect(await run()).toBe(${JSON.stringify(family.output)});`,
			{ "src/driver.py": `${family.code}\n` },
		);
		const result = await invoke(input, family.id, [
			"--target",
			"src/driver.py",
			"--operator",
			family.id,
			"--limit",
			"1",
		]);
		expect(result.code).toBe(0);
		expect(result.selected).toHaveLength(1);
		expect(result.selected[0]?.outcome).toBe("killed");
		expect(result.selected[0]?.restored).toBe(true);
		expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(1);
		const census = rows(result.report.census)
			.map(record)
			.find((row) => row.path === "src/driver.py");
		expect(census?.syntax).toBe("parsed");
		expect(rows(census?.operators)).toHaveLength(15);
		const candidates = rows(result.report.results)
			.map(record)
			.filter((row) => row.path === "src/driver.py");
		const count = rows(census?.operators)
			.map(record)
			.reduce((total, row) => total + Number(row.candidates), 0);
		expect(candidates).toHaveLength(count);
		expect(record(result.report.pythonCapability).implemented).toBe(true);
		expect(result.report.originalHashesVerified).toBe(true);
		expect(result.report.cleanupVerified).toBe(true);
	}, 90000);

for (const fixtureCase of [
	{
		name: "python-survivor",
		source: "print(True)\n",
		assertion: 'expect(typeof await run()).toBe("string");',
		code: 1,
		outcome: "survived",
	},
	{
		name: "python-noCoverage",
		source: "def dormant():\n    return True\nprint('ready')\n",
		assertion: 'expect(await run()).toBe("ready");',
		code: 1,
		outcome: "noCoverage",
	},
	{
		name: "python-crash",
		source: "if not True:\n    raise RuntimeError('mutated')\nprint('ready')\n",
		assertion: 'expect(await run()).toBe("ready");',
		code: 2,
		outcome: "infrastructure",
	},
])
	test(`real Python outcome: ${fixtureCase.name}`, async () => {
		const input = await fixture(pythonEntry, fixtureCase.assertion, {
			"src/driver.py": fixtureCase.source,
		});
		const result = await invoke(input, fixtureCase.name, [
			"--target",
			"src/driver.py",
			"--operator",
			"py-boolean",
			"--limit",
			"1",
		]);
		expect(result.code).toBe(fixtureCase.code);
		expect(result.selected[0]?.outcome).toBe(fixtureCase.outcome);
	}, 90000);

test("missing Python runtime never becomes a zero-candidate pass", async () => {
	const input = await fixture(pythonEntry, 'expect(await run()).toBe("True");', {
		"src/driver.py": "print(True)\n",
	});
	const result = await invoke(input, "missing-python-runtime", select("boolean-literal"), [
		"--python",
		"/not/a/python",
	]);
	expect(result.code).toBe(2);
	expect(result.report.complete).toBe(false);
}, 90000);

for (const example of [
	{
		name: "R2-1 precedence",
		source: "print(~(1 + 2) * 0)\n",
		mutant: "print((1 + 2) * 0)\n",
		operator: "py-unary",
		output: "0",
		mutatedOutput: "0",
		outcome: "survived",
		exit: 1,
	},
	{
		name: "R2-2 literal pattern",
		source: "value = int('1')\nmatch value:\n    case 1:\n        print('one')\n",
		mutant: "value = int('1')\nmatch value:\n    case 0:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern singleton",
		source: "value = bool('yes')\nmatch value:\n    case True:\n        print('one')\n",
		mutant: "value = bool('yes')\nmatch value:\n    case False:\n        print('one')\n",
		operator: "py-boolean",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern mapping key",
		source: "value = {int('1'): 'value'}\nmatch value:\n    case {1: x}:\n        print(x)\n",
		mutant: "value = {int('1'): 'value'}\nmatch value:\n    case {0: x}:\n        print(x)\n",
		operator: "py-number",
		output: "value",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern sequence",
		source: "value = [int('1')]\nmatch value:\n    case [1]:\n        print('one')\n",
		mutant: "value = [int('1')]\nmatch value:\n    case [0]:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern signed literal",
		source: "value = int('-1')\nmatch value:\n    case -1:\n        print('one')\n",
		mutant: "value = int('-1')\nmatch value:\n    case -0:\n        print('one')\n",
		operator: "py-number",
		output: "one",
		mutatedOutput: "",
		outcome: "killed",
		exit: 0,
	},
	{
		name: "pattern unreached later case",
		source:
			"value = 'first'\nmatch value:\n    case 'first':\n        print('first')\n    case 1:\n        print('one')\n",
		mutant:
			"value = 'first'\nmatch value:\n    case 'first':\n        print('first')\n    case 0:\n        print('one')\n",
		operator: "py-number",
		output: "first",
		mutatedOutput: "first",
		outcome: "noCoverage",
		exit: 1,
	},
])
	test(`review R2 counterexample: ${example.name}`, async () => {
		const input = await fixture(
			pythonEntry,
			`expect(await run()).toBe(${JSON.stringify(example.output)});`,
			{
				"src/driver.py": example.source,
			},
		);
		for (const [program, output] of [
			[example.source, example.output],
			[example.mutant, example.mutatedOutput],
		]) {
			if (program === undefined || output === undefined)
				throw new FixtureError("Missing native control");
			const native = await execute(
				[process.env.QUALITY_MUTATION_PYTHON ?? process.env.D945_PYTHON ?? "python3", "-c", program],
				input.root,
				15000,
			);
			expect(native.exitCode).toBe(0);
			expect(native.stdout.trim()).toBe(output);
			evidence.push({ name: `${example.name}: independent native control`, program, ...native });
		}
		const result = await invoke(input, example.name, [
			"--target",
			"src/driver.py",
			"--operator",
			example.operator,
		]);
		expect(result.code).toBe(example.exit);
		expect(result.selected).toHaveLength(1);
		expect(result.selected[0]?.outcome).toBe(example.outcome);
		expect(rows(result.selected[0]?.assertionIdentities)).toHaveLength(
			example.outcome === "killed" ? 1 : 0,
		);
		expect(result.report.originalHashesVerified).toBe(true);
		expect(result.report.cleanupVerified).toBe(true);
	}, 90000);
