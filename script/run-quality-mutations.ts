import { projectOptions } from "./check-types-census";
import { decodeJson as sharedJson } from "./quality-inventory";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

// The inventory producer is a supplied, hash-pinned CLI, not an imported copy of
// another lane. Only that producer decides membership, categories and topology.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Outcome = "killed" | "survived" | "noCoverage" | "invalid" | "infrastructure" | "uncompleted";
type Entry = { path: string; sha256: string; bytes: number; category: string; language: string };
type Operator = { id: string; replacements: Map<string, string[]> };
type Contract = { projects: string[]; roots: string[]; topology: boolean };
type Inventory = {
	files: Entry[];
	historical: Entry[];
	embedded: Entry[];
	configurations: { path: string; sha256: string }[];
};
type Site = {
	start: number;
	end: number;
	mode: "expression" | "statement" | "case" | "jsx" | "python-expression" | "python-statement";
};
type Candidate = {
	id: string;
	path: string;
	sourceSha256: string;
	startOffset: number;
	endOffset: number;
	operator: string;
	replacement: string;
	replacementSha256: string;
	site: Site;
};
type ProcessReceipt = {
	pid: number;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	overflow: boolean;
	spawnError: boolean;
	stdout: string;
	stderr: string;
	stdoutSha256: string;
	stderrSha256: string;
	cleanupExit: number | null;
};
type Result = Candidate & {
	selected: boolean;
	outcome: Outcome;
	typecheck: string;
	testSelection: string;
	assertionIdentities: string[];
	coverage: { reached: boolean; markerSha256: string; tests?: string[] } | null;
	junitReports: string[];
	receipts: ProcessReceipt[];
	reason: string;
	restored: boolean;
};
type Census = {
	path: string;
	sha256: string;
	language: string;
	category: string;
	syntax: string;
	astNodes: number;
	operators: { operator: string; candidates: number; reason: string }[];
};
type ReachSite = { id: string; path: string; sourceSha256: string; site: Site; tests: string[] };
type ProbeEvidence = { reached: boolean; markerSha256: string; tests?: string[] };
type ReachMap = {
	version: 1;
	executionTreeSha256: string;
	candidatesSha256: string;
	testsSha256: string;
	sites: ReachSite[];
	runs: { test: string; receipt: TestSelectionReceipt }[];
	instrumentation: ProcessReceipt[];
	complete: boolean;
	sha256: string;
};
type Options = {
	root: string;
	contract: string;
	inventory: string;
	decision: string;
	inventoryTool: string;
	contractHash: string;
	inventoryHash: string;
	decisionHash: string;
	inventoryToolHash: string;
	dependencies: string;
	python: string;
	tests: string[];
	targets: string[];
	families: string[];
	limit: number;
	maxCandidates: number;
	timeout: number;
	suiteTimeout: number;
	budget: number;
	pilot: boolean;
};

let failure: { code: string; message: string } | null = null;
class MutationError {
	readonly name = "MutationError";
	constructor(
		readonly code: string,
		readonly message: string,
	) { }
}
export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}
function fail(code: string, message: string): never {
	failure = { code, message };
	throw new MutationError(code, message);
}
function object(value: Json | undefined): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail("schema", "Expected object");
	return value;
}
function text(value: Json | undefined): string {
	if (typeof value !== "string") return fail("schema", "Expected string");
	return value;
}
function array(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) return fail("schema", "Expected array");
	return value;
}
function number(value: Json | undefined): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		return fail("schema", "Expected nonnegative integer");
	return value;
}
function hash(value: string): string {
	if (!/^[a-f0-9]{64}$/.test(value)) return fail("schema", "Expected SHA256");
	return value;
}
function pathIn(root: string, path: string): string {
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		return fail("schema", `Unsafe relative path: ${path}`);
	const absolute = resolve(root, path);
	if (
		existsSync(absolute) &&
		(lstatSync(absolute).isSymbolicLink() ||
			!realpathSync(absolute).startsWith(`${realpathSync(root)}/`))
	)
		return fail("schema", `Source escapes root: ${path}`);
	return absolute;
}

// Decode JSON through the pinned public compiler AST. No JSON.parse top-typed
// application payload, casts, declaration patches, or boundary exemptions.
export function decode(input: string): Json {
	try { return sharedJson(input); }
	catch { return fail("json", "invalid JSON"); }
}

function readJson(path: string): Json {
	return decode(readFileSync(path, "utf8"));
}
function pinned(path: string, expected: string): string {
	const content = readFileSync(path, "utf8");
	if (sha256(content) !== hash(expected)) return fail("tamper", `Hash mismatch: ${path}`);
	return content;
}
function contractAt(path: string): Contract {
	const data = object(readJson(path));
	if (data.version !== 1 || data.typescript !== "5.9.2" || typeof data.topology !== "boolean")
		return fail("schema", "Unsupported canonical contract");
	const projects = array(data.projects).map(text);
	const roots = array(data.roots).map(text);
	if (!projects.length || !roots.length) return fail("incompleteInventory", "Empty contract");
	return { projects, roots, topology: data.topology };
}
function entry(value: Json): Entry {
	const row = object(value);
	const result = {
		path: text(row.path),
		sha256: hash(text(row.sha256)),
		bytes: number(row.bytes),
		category: text(row.category),
		language: text(row.language),
	};
	if (
		!["production", "tooling", "test", "fixture", "benchmark", "migration", "historical"].includes(
			result.category,
		) ||
		!["typescript", "javascript", "python", "sql"].includes(result.language)
	)
		return fail("schema", "Invalid canonical entry");
	return result;
}
function inventoryAt(path: string): Inventory {
	const data = object(readJson(path));
	if (data.version !== 1) return fail("schema", "Unsupported inventory version");
	hash(text(data.contractHash));
	const result = {
		files: array(data.files).map(entry),
		historical: array(data.historical).map(entry),
		embedded: array(data.embedded).map(entry),
		configurations: array(data.configurations).map((value) => {
			const row = object(value);
			return { path: text(row.path), sha256: hash(text(row.sha256)) };
		}),
	};
	if (
		!result.files.length ||
		new Set(result.files.map((file) => file.path)).size !== result.files.length
	)
		return fail("incompleteInventory", "Empty or duplicate inventory");
	return result;
}
const familyIds = [
	"boolean-literal",
	"equality",
	"relational",
	"arithmetic",
	"logical",
	"bitwise",
	"unary",
	"update",
	"assignment",
	"numeric-literal",
	"bigint-literal",
	"string-literal",
	"condition",
	"conditional-arm",
	"statement-delete",
	"return-value",
	"throw-delete",
	"array-literal",
	"object-literal",
	"optional-chain",
	"await-delete",
	"switch-case",
	"regex",
	"method",
];
function operatorsAt(path: string): Operator[] {
	const contract = object(object(readJson(path)).contract);
	const bounds = object(contract.hardBounds);
	if (
		bounds.survivingMutants !== 0 ||
		array(bounds.allowlists).length ||
		array(bounds.grandfathered).length
	)
		return fail("operatorContract", "Mutation thresholds cannot be weakened");
	const mutation = object(contract.mutation);
	if (mutation.algorithm !== "d945-mutation@1" || array(mutation.equivalentMutantAllowlist).length)
		return fail("operatorContract", "Unsupported mutation algorithm");
	if (
		sha256(JSON.stringify(mutation.operators)) !==
		"3ce0e7eedec5b153986b12e1ca5b8a25ec2f373f8529f51e526ae67e1c2b8bfd"
	)
		return fail(
			"operatorContract",
			"Operator definitions differ from implemented frozen d945-mutation@1",
		);
	const operators = array(mutation.operators).map((value) => {
		const row = object(value);
		return {
			id: text(row.id),
			replacements: new Map(
				Object.entries(object(row.replacements)).map(([key, values]) => [
					key,
					array(values).map(text),
				]),
			),
		};
	});
	if (
		operators.length !== familyIds.length ||
		new Set(operators.map((op) => op.id)).size !== familyIds.length ||
		operators.some((op) => !familyIds.includes(op.id))
	)
		return fail("operatorContract", "Incomplete or unsupported operator census");
	return operators;
}

export async function execute(
	argv: string[],
	cwd: string,
	timeout: number,
	environment: Record<string, string> = {},
): Promise<ProcessReceipt> {
	const output = { stdout: "", stderr: "" };
	const hashes = { stdout: new Bun.CryptoHasher("sha256"), stderr: new Bun.CryptoHasher("sha256") };
	let timedOut = false;
	let overflow = false;
	let pid = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function terminate(): number | null {
		if (!pid) return null;
		// A nonexistent process group produces exit 1, retained in the receipt.
		return spawnSync("/bin/kill", ["-KILL", "--", `-${pid}`], { stdio: "ignore" }).status;
	}
	try {
		const child = Bun.spawn(argv, {
			cwd,
			detached: true,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, FORCE_COLOR: "0", ...environment },
			onExit: () => {
				terminate();
			},
		});
		pid = child.pid;
		timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeout);
		async function consume(
			channel: "stdout" | "stderr",
			stream: ReadableStream<Uint8Array>,
		): Promise<void> {
			const reader = stream.getReader();
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					hashes[channel].update(chunk.value);
					if (output[channel].length + chunk.value.length > 1_048_576) {
						overflow = true;
						terminate();
					}
					output[channel] += Buffer.from(chunk.value)
						.toString("utf8")
						.slice(0, Math.max(0, 1_048_576 - output[channel].length));
				}
			} finally {
				reader.releaseLock();
			}
		}
		await Promise.all([
			consume("stdout", child.stdout),
			consume("stderr", child.stderr),
			child.exited,
		]);
		return {
			pid,
			exitCode: child.exitCode,
			signal: child.signalCode,
			timedOut,
			overflow,
			spawnError: false,
			...output,
			stdoutSha256: hashes.stdout.digest("hex"),
			stderrSha256: hashes.stderr.digest("hex"),
			cleanupExit: terminate(),
		};
	} catch {
		return {
			pid,
			exitCode: null,
			signal: null,
			timedOut,
			overflow,
			spawnError: true,
			...output,
			stdoutSha256: hashes.stdout.digest("hex"),
			stderrSha256: hashes.stderr.digest("hex"),
			cleanupExit: terminate(),
		};
	} finally {
		clearTimeout(timer);
	}
}
function broken(receipt: ProcessReceipt): boolean {
	return (
		receipt.timedOut ||
		receipt.overflow ||
		receipt.spawnError ||
		receipt.signal !== null ||
		receipt.exitCode === null ||
		(receipt.cleanupExit !== 0 && receipt.cleanupExit !== 1)
	);
}
function projectProgram(root: string, path: string): ts.Program {
	pathIn(root, path);
	console.error(`[mutation] compiler project ${path}`);
	try {
		const parsed = projectOptions(root, path);
		return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, incremental: false, composite: false });
	} catch { return fail("configuration", `invalid native project: ${path}`); }
}
export function* programs(root: string, contract: Contract, inventory: Inventory): Generator<ts.Program, void, undefined> {
	const covered = new Set<string>();
	for (const path of contract.projects) {
		const program = projectProgram(root, path);
		for (const source of program.getSourceFiles()) covered.add(source.fileName);
		yield program;
	}
	// Supplied native-project coverage first; only canonical remaining members
	// enter the same strict inventory fallback used by the delegated type owner.
	const remaining = inventory.files
		.filter((file) => ["typescript", "javascript"].includes(file.language))
		.map((file) => pathIn(root, file.path))
		.filter((path) => !covered.has(path));
	if (remaining.length)
		yield ts.createProgram(remaining, {
				strict: true,
				noEmit: true,
				allowJs: true, checkJs: false, // untyped inventory JS is outside compiler contracts
				rootDir: root,
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				jsx: ts.JsxEmit.Preserve,
				skipLibCheck: true,
			});
}
const diagnosticHost: ts.FormatDiagnosticsHost = {
	getCanonicalFileName: (name) => name,
	getCurrentDirectory: () => process.cwd(),
	getNewLine: () => "\n",
};
export function diagnostics(items: Iterable<ts.Program>): string[] {
	const errors: string[] = [];
	for (const program of items)
		for (const diagnostic of ts.getPreEmitDiagnostics(program))
			errors.push(ts.formatDiagnostics([diagnostic], diagnosticHost));
	return errors;
}
function runtimeNode(node: ts.Node): boolean {
	if (
		ts.isTypeNode(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isImportDeclaration(node) ||
		ts.isExportDeclaration(node)
	)
		return false;
	return !(
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
	);
}
function literalValue(node: ts.Node): boolean {
	const parent = node.parent;
	if (ts.isExpressionStatement(parent) && directive(parent)) return false;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
	if (
		(ts.isPropertyAssignment(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isBindingElement(parent) ||
			ts.isEnumMember(parent)) &&
		parent.name === node
	)
		return false;
	if (ts.isImportTypeNode(parent) || ts.isLiteralTypeNode(parent)) return false;
	if (
		ts.isCallExpression(parent) &&
		(parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
			(ts.isIdentifier(parent.expression) && parent.expression.text === "require")) &&
		parent.arguments[0] === node
	)
		return false;
	return true;
}
function directive(node: ts.ExpressionStatement): boolean {
	if (!ts.isStringLiteral(node.expression)) return false;
	const parent = node.parent;
	if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return false;
	for (const statement of parent.statements) {
		if (statement === node) return true;
		if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))
			return false;
	}
	return false;
}
function regexTokenReplacement(char: string | undefined): string | null {
	return char === "+" ? "*" : char === "*" ? "+" : ["^", "$", "?"].includes(char ?? "") ? "" : null;
}
function regexChanges(raw: string): string[] {
	const slash = raw.lastIndexOf("/");
	const body = raw.slice(1, slash);
	const flags = raw.slice(slash + 1);
	const result: string[] = [];
	let inClass = false;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "[") {
			inClass = true;
			continue;
		}
		if (char === "]") {
			inClass = false;
			continue;
		}
		if (inClass || (char === "?" && body[index - 1] === "(")) continue;
		const replacement = regexTokenReplacement(char);
		if (replacement !== null)
			result.push(`/${body.slice(0, index)}${replacement}${body.slice(index + 1)}/${flags}`);
	}
	for (const flag of ["i", "g"])
		result.push(`/${body}/${flags.includes(flag) ? flags.replace(flag, "") : flags + flag}`);
	return result;
}

export function enumerate(
	root: string,
	inventory: Inventory,
	operators: Operator[],
	items: ts.Program[],
): { candidates: Candidate[]; census: Census[]; errors: string[] } {
	const candidates: Candidate[] = [];
	const census: Census[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const file of [...inventory.files, ...inventory.historical, ...inventory.embedded]) {
		const firstCandidate = candidates.length;
		const row: Census = {
			path: file.path,
			sha256: file.sha256,
			category: file.category,
			language: file.language,
			syntax: "parsed",
			astNodes: 0,
			operators: [],
		};
		census.push(row);
		const eligible = file.category !== "historical" && file.language !== "sql";
		if (!eligible) row.syntax = "outside-executable-TS-JS-contract";
		else if (file.language === "python") {
			row.syntax = "pending-python-AST";
		} else {
			const absolute = pathIn(root, file.path);
			const owner = items.find((program) => program.getSourceFile(absolute));
			const selected = owner?.getSourceFile(absolute);
			if (!owner || !selected) {
				row.syntax = "incompleteInventory";
				errors.push(`${file.path}: no owning compiler project`);
			} else if (owner.getSyntacticDiagnostics(selected).length) {
				row.syntax = "unsupportedSyntax";
				errors.push(`${file.path}: parser rejected source`);
			} else if (!selected.isDeclarationFile) {
				const source = selected;
				const checker = owner.getTypeChecker();
				function add(
					op: string,
					node: ts.Node,
					replacement: string,
					siteNode: ts.Node = node,
					mode: Site["mode"] = "expression",
				): void {
					const startOffset = node.getStart(source);
					const endOffset = node.end;
					if (source.text.slice(startOffset, endOffset) === replacement) return;
					const replacementSha256 = sha256(replacement);
					const id = sha256(`${file.path}\0${startOffset}\0${endOffset}\0${replacementSha256}`);
					if (seen.has(id)) return;
					seen.add(id);
					const boundary = mode === "expression" ? valueBoundary(siteNode) : siteNode;
					candidates.push({
						id,
						path: file.path,
						sourceSha256: file.sha256,
						startOffset,
						endOffset,
						operator: op,
						replacement,
						replacementSha256,
						site: { start: boundary.getStart(source), end: boundary.end, mode },
					});
				}
				function addScalarMutations(node: ts.Node, raw: string): void {
					if (ts.isBinaryExpression(node))
						for (const op of operators)
							for (const replacement of op.replacements.get(node.operatorToken.getText(source)) ??
								[])
								add(op.id, node.operatorToken, replacement, node);
					if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
						add("boolean-literal", node, raw === "true" ? "false" : "true");
					if (ts.isNumericLiteral(node) && literalValue(node) && Number.isFinite(Number(node.text)))
						add("numeric-literal", node, Number(node.text) === 0 ? "1" : "0");
					if (ts.isBigIntLiteral(node) && literalValue(node))
						add(
							"bigint-literal",
							node,
							BigInt(node.text.slice(0, -1).replaceAll("_", "")) === 0n ? "1n" : "0n",
						);
				}
				function addTemplateMutations(
					node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
				): void {
					const embedded = inventory.embedded.some(
						(entry) =>
							entry.path === `${file.path}#PYTHON_DRIVER` &&
							ts.isVariableDeclaration(node.parent.parent) &&
							node.parent.parent.name.getText(source) === "PYTHON_DRIVER",
					);
					if (embedded) return;
					// Quasis are template data, not ordinary expression literals.
					// Keep tag/receiver/substitutions and the raw/cooked pair intact.
					const parts = ts.isTemplateExpression(node)
						? [node.head, ...node.templateSpans.map((span) => span.literal)]
						: [node];
					for (const part of parts) {
						const opening = ts.isTemplateMiddle(part) || ts.isTemplateTail(part) ? "}" : "`";
						const closing = ts.isTemplateHead(part) || ts.isTemplateMiddle(part) ? "${" : "`";
						add(
							"string-literal",
							part,
							`${opening}${part.getText(source).length > opening.length + closing.length ? "" : "__d945_mutant__"}${closing}`,
							node.parent,
						);
					}
				}
				function addStringMutations(node: ts.Node): void {
					if (
						(ts.isStringLiteral(node) ||
							ts.isNoSubstitutionTemplateLiteral(node) ||
							ts.isTemplateExpression(node)) &&
						literalValue(node)
					) {
						if (ts.isTaggedTemplateExpression(node.parent)) addTemplateMutations(node);
						else
							add(
								"string-literal",
								node,
								ts.isTemplateExpression(node) || node.text.length ? '""' : '"__d945_mutant__"',
								node,
								ts.isJsxAttribute(node.parent) ? "jsx" : "expression",
							);
					}
				}
				function addUnaryMutations(node: ts.Node): void {
					if (ts.isPrefixUnaryExpression(node)) {
						const operand = node.operand.getText(source);
						const unary = new Map([
							[ts.SyntaxKind.ExclamationToken, `(${operand})`],
							[ts.SyntaxKind.TildeToken, `(${operand})`],
							[ts.SyntaxKind.PlusToken, `-(${operand})`],
							[ts.SyntaxKind.MinusToken, `+(${operand})`],
						]);
						const replacement = unary.get(node.operator);
						if (replacement) add("unary", node, replacement);
					}
					if (
						(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
						(node.operator === ts.SyntaxKind.PlusPlusToken ||
							node.operator === ts.SyntaxKind.MinusMinusToken)
					) {
						const token = node.operator === ts.SyntaxKind.PlusPlusToken ? "--" : "++";
						add(
							"update",
							node,
							ts.isPrefixUnaryExpression(node)
								? `${token}${node.operand.getText(source)}`
								: `${node.operand.getText(source)}${token}`,
						);
					}
				}
				function addConditionMutations(node: ts.Node): void {
					if (
						ts.isIfStatement(node) ||
						ts.isWhileStatement(node) ||
						ts.isDoStatement(node) ||
						ts.isForStatement(node) ||
						ts.isConditionalExpression(node)
					) {
						const condition = ts.isForStatement(node)
							? node.condition
							: ts.isConditionalExpression(node)
								? node.condition
								: node.expression;
						if (condition)
							for (const replacement of ["true", "false"]) add("condition", condition, replacement);
					}
					if (ts.isConditionalExpression(node))
						add(
							"conditional-arm",
							node,
							`(${node.condition.getText(source)}) ? (${node.whenFalse.getText(source)}) : (${node.whenTrue.getText(source)})`,
						);
				}
				function addStatementAndCollectionMutations(node: ts.Node): void {
					if (ts.isExpressionStatement(node) && !directive(node))
						add("statement-delete", node, ";", node, "statement");
					if (ts.isReturnStatement(node) && node.expression)
						add("return-value", node.expression, "undefined");
					if (ts.isThrowStatement(node)) add("throw-delete", node, ";", node, "statement");
					if (ts.isArrayLiteralExpression(node) && node.elements.length)
						add("array-literal", node, "[]");
					if (ts.isObjectLiteralExpression(node) && node.properties.length)
						add("object-literal", node, "{}");
				}
				function addAccessAndControlMutations(node: ts.Node, raw: string): void {
					if (
						(ts.isPropertyAccessExpression(node) ||
							ts.isElementAccessExpression(node) ||
							ts.isCallExpression(node)) &&
						node.questionDotToken
					)
						add(
							"optional-chain",
							node.questionDotToken,
							ts.isPropertyAccessExpression(node) ? "." : "",
							node,
						);
					if (ts.isAwaitExpression(node))
						add("await-delete", node, `(${node.expression.getText(source)})`);
					if (
						ts.isCaseClause(node) &&
						(ts.isLiteralExpression(node.expression) ||
							node.expression.kind === ts.SyntaxKind.TrueKeyword ||
							node.expression.kind === ts.SyntaxKind.FalseKeyword)
					)
						add("switch-case", node, "", node, "case");
					if (ts.isRegularExpressionLiteral(node))
						for (const replacement of regexChanges(raw)) add("regex", node, replacement);
				}
				function addMethodMutations(node: ts.Node): void {
					if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
						const access = node.expression;
						const receiver = checker.getTypeAtLocation(access.expression);
						const name = access.name.text;
						const isArray = checker.isArrayType(receiver) || checker.isTupleType(receiver);
						const isString = (receiver.flags & ts.TypeFlags.StringLike) !== 0;
						if (isArray && name === "filter" && node.arguments[0])
							add("method", node.arguments[0], "() => true", node);
						if (isArray && (name === "every" || name === "some"))
							add("method", access.name, name === "every" ? "some" : "every", node);
						if (isString && (name === "startsWith" || name === "endsWith"))
							add("method", access.name, name === "startsWith" ? "endsWith" : "startsWith", node);
					}
				}
				function visit(node: ts.Node): void {
					row.astNodes++;
					if (!runtimeNode(node)) return;
					const raw = node.getText(source);
					addScalarMutations(node, raw);
					addStringMutations(node);
					addUnaryMutations(node);
					addConditionMutations(node);
					addStatementAndCollectionMutations(node);
					addAccessAndControlMutations(node, raw);
					addMethodMutations(node);
					ts.forEachChild(node, visit);
				}
				visit(source);
			}
		}
		const fileCandidates = candidates.slice(firstCandidate);
		row.operators = operators.map((op) => {
			const count = fileCandidates.filter((candidate) => candidate.operator === op.id).length;
			return {
				operator: op.id,
				candidates: count,
				reason: count
					? "enumerated"
					: row.syntax === "parsed"
						? "no-applicable-runtime-AST-site"
						: row.syntax,
			};
		});
	}
	candidates.sort(compareCandidates);
	return { candidates, census, errors };
}
// Preserve first-project ownership without retaining every project's checker.
export function analyze(root: string, contract: Contract, inventory: Inventory, operators: Operator[]) {
	const pending = new Map(inventory.files.map((file) => [file.path, file]));
	const result: ReturnType<typeof enumerate> = { candidates: [], census: [], errors: [] };
	const sourceDiagnostics: string[] = [];
	for (const program of programs(root, contract, inventory)) {
		const files = [...pending.values()].filter((file) =>
			["typescript", "javascript"].includes(file.language) && program.getSourceFile(pathIn(root, file.path)),
		);
		const part = enumerate(root, { files, historical: [], embedded: inventory.embedded, configurations: [] }, operators, [program]);
		result.candidates.push(...part.candidates);
		result.census.push(...part.census.filter((row) => row.language !== "python"));
		result.errors.push(...part.errors);
		sourceDiagnostics.push(...diagnostics([program]));
		for (const file of files) pending.delete(file.path);
	}
	const rest = enumerate(root, { ...inventory, files: [...pending.values()] }, operators, []);
	result.candidates.push(...rest.candidates);
	result.census.push(...rest.census);
	result.errors.push(...rest.errors);
	const rows = new Map(result.census.map((row) => [row.path, row]));
	result.census = [...inventory.files, ...inventory.historical, ...inventory.embedded].flatMap((file) => {
		const row = rows.get(file.path);
		return row ? [row] : [];
	});
	return { enumerated: result, sourceDiagnostics };
}

// Probe a value-producing boundary, never sever a Reference used as a callee,
// delete operand, or continuing optional chain. Arguments/keys stay lazy.
function valueBoundary(node: ts.Node): ts.Node {
	const parent = node.parent;
	if (
		((ts.isPropertyAccessExpression(parent) ||
			ts.isElementAccessExpression(parent) ||
			ts.isCallExpression(parent) ||
			ts.isParenthesizedExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isTypeAssertionExpression(parent) ||
			ts.isDeleteExpression(parent)) &&
			parent.expression === node) ||
		(ts.isTaggedTemplateExpression(parent) && parent.tag === node)
	)
		return valueBoundary(parent);
	return node;
}
function compare(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function compareCandidates(a: Candidate, b: Candidate): number {
	return (
		compare(a.path, b.path) ||
		a.startOffset - b.startOffset ||
		compare(a.operator, b.operator) ||
		compare(a.replacement, b.replacement)
	);
}
function replace(source: string, start: number, end: number, replacement: string): string {
	return source.slice(0, start) + replacement + source.slice(end);
}
type ProbeInsertion = { offset: number; order: number; text: string };
function caseInsertion(source: string, site: Site): number {
	const original = source.slice(site.start, site.end);
	const clause = ts.createSourceFile("site.ts", `switch(0){${original}}`, ts.ScriptTarget.Latest, true);
	const statement = clause.statements[0];
	if (!statement || !ts.isSwitchStatement(statement)) return fail("instrumentation", "Missing switch site");
	const first = statement.caseBlock.clauses[0];
	if (!first || !ts.isCaseClause(first)) return fail("instrumentation", "Missing case site");
	return site.start + original.indexOf(":", first.expression.end - "switch(0){".length) + 1;
}
function probeInsertions(source: string, row: ReachSite, marker: string, index: number): ProbeInsertion[] {
	const { site } = row;
	const key = JSON.stringify(marker);
	const probe = `require("node:fs").writeFileSync(${key},"1")`;
	if (site.mode === "case") return [{ offset: caseInsertion(source, site), order: index, text: `${probe};` }];
	const [open, close] = site.mode === "statement" ? [`{${probe};`, "}"]
		: site.mode === "jsx" ? [`{(${probe},(`, "))}"] : [`(${probe},(`, "))"];
	return [{ offset: site.start, order: index, text: open }, { offset: site.end, order: -index, text: close }];
}
function instrumentSingle(source: string, site: Site, marker: string): string {
	const probe = `require("node:fs").writeFileSync(${JSON.stringify(marker)},"1")`;
	const original = source.slice(site.start, site.end);
	if (site.mode === "statement") return replace(source, site.start, site.end, `{${probe};${original}}`);
	if (site.mode === "case") return replace(source, caseInsertion(source, site), caseInsertion(source, site), `${probe};`);
	const expression = `(${probe},(${original}))`;
	return replace(source, site.start, site.end, site.mode === "jsx" ? `{${expression}}` : expression);
}
export function instrument(source: string, sites: ReachSite[], directory: string): string {
	const [only] = sites;
	if (only && sites.length === 1) return instrumentSingle(source, only.site, join(directory, only.id));
	// Insert against original offsets; nested sites must not shift or overwrite one another.
	const ordered = [...sites].sort((a, b) => b.site.start - a.site.start || a.site.end - b.site.end);
	return ordered.reduce((result, row) => instrumentSingle(result, row.site, join(directory, row.id)), source);
}
function gitCopyCommand(root: string, args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) return fail("executionCopy", result.stderr || String(result.error));
	return result.stdout;
}
export function copyExecution(sourceRoot: string, target: string): void {
	if (existsSync(join(sourceRoot, ".git"))) // Own detached index; share Git objects/history.
		gitCopyCommand(sourceRoot, ["worktree", "add", "--detach", target, "HEAD"]);
	const skipped = new Set([".git", ".omo", "coverage", ".turbo"]); // Copy dependencies; reject external links.
	cpSync(sourceRoot, target, {
		recursive: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		filter: (source) =>
			!relative(sourceRoot, source)
				.split("/")
				.some((part) => skipped.has(part)),
	});
}
export function removeExecution(root: string): void {
	if (existsSync(join(root, ".git"))) {
		const owner = gitCopyCommand(root, ["rev-parse", "--git-common-dir"]).trim();
		gitCopyCommand(root, ["worktree", "remove", "--force", root]);
		const list = spawnSync("git", ["--git-dir", owner, "worktree", "list", "--porcelain"], { encoding: "utf8" });
		if (list.status !== 0 || list.stdout.split("\n").includes(`worktree ${root}`))
			fail("cleanup", `Execution worktree registration remains: ${root}`);
	}
	rmSync(root, { recursive: true, force: true });
}
function snapshot(options: Options, target: string): void {
	copyExecution(options.root, target);
	// Standalone fixtures may supply a separate, minimal dependency installation.
	if (options.dependencies !== join(options.root, "node_modules"))
		cpSync(options.dependencies, join(target, "node_modules"), {
			recursive: true,
			dereference: true,
			mode: constants.COPYFILE_FICLONE,
		});
}
function verifySources(root: string, inventory: Inventory): void {
	for (const file of [...inventory.files, ...inventory.historical, ...inventory.configurations]) {
		if (sha256(readFileSync(pathIn(root, file.path))) !== file.sha256)
			fail("tamper", `Source hash mismatch: ${file.path}`);
	}
}
// Execution-copy identity includes configs, assets and dependencies. This is
// not source discovery: it cannot add, remove or categorize inventory members.
function visitExecutionTree(root: string, hasher: Bun.CryptoHasher, directory: string): void {
	for (const name of readdirSync(directory).sort(compare)) {
		const path = join(directory, name);
		if (lstatSync(path).isSymbolicLink()) {
			const link = readlinkSync(path);
			const destination = relative(root, realpathSync(path));
			if (isAbsolute(link) || destination === ".." || destination.startsWith(`..${sep}`))
				fail("isolation", `External symlink in execution copy: ${relative(root, path)}`);
			hasher.update(`${relative(root, path)}\0link\0${link}\0`);
		} else if (lstatSync(path).isDirectory()) visitExecutionTree(root, hasher, path);
		else hasher.update(`${relative(root, path)}\0${sha256(readFileSync(path))}\0`);
	}
}
export function executionTreeHash(directory: string): string {
	const root = realpathSync(directory);
	const hasher = new Bun.CryptoHasher("sha256");
	visitExecutionTree(root, hasher, root);
	return hasher.digest("hex");
}
type TestsReceipt = {
	process: ProcessReceipt;
	junit: string;
	tests: number;
	failures: number;
	assertions: string[];
	valid: boolean;
};
type TestSelectionReceipt = {
	batches: TestsReceipt[];
	tests: number;
	failures: number;
	assertions: string[];
	valid: boolean;
	exitCode: number;
};
function testGroups(root: string, tests: string[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const test of tests) {
		let cwd = dirname(join(root, test));
		while (cwd !== root && !existsSync(join(cwd, "package.json"))) cwd = dirname(cwd);
		const selected = groups.get(cwd) ?? [];
		selected.push(relative(cwd, join(root, test)));
		groups.set(cwd, selected);
	}
	return groups;
}
async function runTests(root: string, tests: string[], timeout: number, directory: string, python: string, suiteTimeout: number): Promise<TestSelectionReceipt> {
	const batches: TestsReceipt[] = [];
	for (const [cwd, selected] of testGroups(root, tests)) {
		console.error(`[mutation] test package ${relative(root, cwd) || "."} (${selected.length} files)`);
		batches.push(await runTestBatch(cwd, selected, timeout, directory, python, suiteTimeout));
	}
	return {
		batches,
		tests: batches.reduce((sum, batch) => sum + batch.tests, 0),
		failures: batches.reduce((sum, batch) => sum + batch.failures, 0),
		assertions: batches.flatMap((batch) => batch.assertions),
		valid: batches.every((batch) => batch.valid),
		exitCode: batches.every((batch) => batch.process.exitCode === 0) ? 0 : 1,
	};
}
async function runTestBatch(
	root: string,
	tests: string[],
	timeout: number,
	directory: string,
	python: string,
	suiteTimeout: number,
): Promise<TestsReceipt> {
	const report = join(directory, "tests.xml");
	rmSync(report, { force: true });
	const processReceipt = await execute(
		[
			process.execPath,
			"--smol",
			"test",
			"--timeout",
			String(timeout),
			"--reporter=junit",
			`--reporter-outfile=${report}`,
			...tests.map((test) => `./${test}`),
		],
		root,
		Math.max(suiteTimeout, timeout * tests.length),
		python ? { PATH: `${dirname(python)}:${process.env.PATH ?? ""}` } : {},
	);
	const xml = existsSync(report) ? readFileSync(report, "utf8") : "";
	const header = xml.match(/<testsuites\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"/);
	return {
		process: processReceipt,
		junit: xml,
		tests: Number(header?.[1] ?? 0),
		failures: Number(header?.[2] ?? 0),
		assertions: assertionIdentities(xml, processReceipt.stderr),
		valid: !!header && !broken(processReceipt),
	};
}
function assertionDiagnostic(segment: string[]): boolean {
	const errors = segment.filter((item) => /^(?:error|[A-Za-z]*Error):/.test(item));
	const expectation = errors.length > 0 && errors.every((item) =>
		/^error: expect\(received\)\.(?:(?:not|resolves|rejects)\.)*[A-Za-z]+\(/.test(item),
	);
	const settlement = errors.length === 1 && /^error:\s*$/.test(errors[0] ?? "") &&
		/^Expected promise that (?:rejects\nReceived promise that resolved|resolves\nReceived promise that rejected):/m.test(segment.join("\n"));
	return expectation || settlement;
}
function appendAssertionFailure(output: string[], file: string, segment: string[], status: RegExpMatchArray | null): void {
	if (status?.[1] === "fail" && assertionDiagnostic(segment)) output.push(`${file}\0${status[2]}`);
}
export function failedAssertions(stderr: string): string[] {
	const failedNames: string[] = [];
	let file = "";
	let segment: string[] = [];
	for (const line of stderr.split("\n")) {
		const found = line.match(/^(?:::group::)?([^\s].*\.[cm]?[jt]sx?):$/)?.[1];
		if (found) { file = found.replace(/^\.\//, ""); segment = []; }
		const status = line.match(/^\((pass|fail)\) (.*?)(?: \[[\d.]+ms\])?$/);
		if (status) { appendAssertionFailure(failedNames, file, segment, status); segment = []; }
		else segment.push(line);
	}
	return failedNames;
}
function assertionIdentities(xml: string, stderr: string): string[] {
	const failedNames = failedAssertions(stderr);
	const assertionCases = [
		...xml.matchAll(/<testcase\b([^>]+)(?<!\/)>([\s\S]*?)<\/testcase>/g),
	].filter(
		(match) =>
			/<failure\b[^>]*\btype="AssertionError"(?:\s[^>]*)?\s*\/?>(?:[\s\S]*?<\/failure>)?/.test(
				match[2] ?? "",
			) &&
			(/\bassertions="[1-9]\d*"/.test(match[1] ?? "") ||
				// Bun 1.4.1 reports zero assertions for .resolves on a rejection.
				// Require its structured matcher diagnostic as well as the associated
				// stderr failure; an ordinary exception still cannot count as a kill.
				(/\bmessage="expect\(received\)\.resolves\.[A-Za-z]+\(/.test(match[2] ?? "") &&
					/Expected promise that resolves&#10;Received promise that rejected:/.test(
						match[2] ?? "",
					))),
	);
	function attribute(attributes: string, name: string): string {
		const encoded = attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
		return encoded
			.replaceAll("&quot;", '"')
			.replaceAll("&apos;", "'")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&amp;", "&");
	}
	const assertions = assertionCases.flatMap((match) => {
		const attributes = match[1] ?? "";
		const file = attribute(attributes, "file").replace(/^\.\//, "");
		const name = attribute(attributes, "name");
		const group = attribute(attributes, "classname");
		const key = `${file}\0${group ? `${group} > ` : ""}${name}`;
		const index = failedNames.indexOf(key);
		if (index < 0) return [];
		failedNames.splice(index, 1);
		return [JSON.stringify({ file, name, line: attribute(attributes, "line") })];
	});
	return assertions;
}
function green(receipt: TestSelectionReceipt): boolean {
	return (
		receipt.valid && receipt.tests > 0 && receipt.failures === 0 && receipt.exitCode === 0
	);
}
async function buildReachMap(options: Options, frozen: string, temporary: string, candidates: Candidate[], tests: string[], executionTreeSha256: string): Promise<{ map: Map<string, ProbeEvidence>; receipt: ReachMap }> {
	const directory = join(temporary, "reach"), markers = join(directory, "markers");
	copyExecution(frozen, directory);
	mkdirSync(markers, { recursive: true });
	const byPath = new Map<string, Candidate[]>();
	for (const candidate of candidates)
		if (!candidate.operator.startsWith("py-")) byPath.set(candidate.path, [...(byPath.get(candidate.path) ?? []), candidate]);
	for (const [candidatePath, rows] of byPath) {
		const source = mutationSource(directory, candidatePath);
		if (rows[0]?.operator.startsWith("py-")) {
			const sites = join(directory, "python-sites.json");
			writeFileSync(sites, JSON.stringify(rows.map((row) => ({ ...row.site, marker: join(markers, row.id) }))));
			const process = await pythonWorker(options, source.source, directory, "reach", undefined, undefined, sites);
			if (process.exitCode !== 0) throw new MutationError("reachMap", "Python reach instrumentation failed");
			writeMutation(source, text(object(decode(process.stdout)).source));
		} else {
			const unique = [...new Map(rows.map((row) => [`${row.site.start}:${row.site.end}:${row.site.mode}`, row])).values()];
			const active = unique.filter((row) => !unique.some((other) => other !== row && other.site.start <= row.site.start && other.site.end >= row.site.end && (other.site.start < row.site.start || other.site.end > row.site.end)));
			const instrumented = instrument(source.source, active.map((row) => ({ id: row.id, path: row.path, sourceSha256: row.sourceSha256, site: row.site, tests })), markers);
			writeMutation(source, instrumented);
		}
	}
	const map = new Map<string, ProbeEvidence>();
	for (const candidate of candidates) map.set(candidate.id, { reached: false, markerSha256: sha256(""), tests: [] });
	const runs: { test: string; receipt: TestSelectionReceipt }[] = [];
	for (const test of tests) {
		if (readFileSync(join(directory, test), "utf8").trim() === "") continue;
		const receipt = await runTests(directory, [test], options.timeout, temporary, options.python, options.suiteTimeout);
		if (!receipt.valid || receipt.failures !== 0 || receipt.exitCode !== 0)
			throw new MutationError("reachMap", `Reach test is not green: ${test}`);
		runs.push({ test, receipt });
		for (const candidate of candidates) {
			const first = candidates.filter((row) => row.path === candidate.path && JSON.stringify(row.site) === JSON.stringify(candidate.site)).at(-1) ?? candidate;
			let marker = join(markers, first.id);
			if (!existsSync(marker)) {
				const covering = candidates.find((row) => row.path === candidate.path && existsSync(join(markers, row.id)));
				if (covering) marker = join(markers, covering.id);
			}
			if (!existsSync(marker)) continue;
			const evidence = map.get(candidate.id);
			if (evidence) {
				evidence.reached = true;
				if (!evidence.tests) evidence.tests = [];
				evidence.tests.push(test);
				evidence.markerSha256 = sha256(readFileSync(marker, "utf8"));
			}
		}
	}
	console.error(`[mutation] reach map: ${[...map.values()].filter((value) => value.reached).length}/${candidates.length} reached`);
	const body = { version: 1 as const, executionTreeSha256, candidatesSha256: sha256(JSON.stringify(candidates)), testsSha256: sha256(JSON.stringify(tests)), sites: candidates.map((candidate) => ({ id: candidate.id, path: candidate.path, sourceSha256: candidate.sourceSha256, site: candidate.site, tests: map.get(candidate.id)?.tests ?? [] })), runs, complete: true };
	return { map, receipt: { ...body, instrumentation: [], sha256: sha256(JSON.stringify(body)) } };
}

function defaultResult(candidate: Candidate, tests: string[], selected = true): Result {
	return {
		...candidate,
		selected,
		outcome: "uncompleted",
		typecheck: "not-run",
		testSelection: sha256(JSON.stringify(tests)),
		assertionIdentities: [],
		coverage: null,
		junitReports: [],
		receipts: [],
		reason: selected ? "execution-not-completed" : "outside-pilot-selection",
		restored: true,
	};
}
export function mutationSource(
	root: string,
	candidatePath: string,
): {
	path: string;
	source: string;
	host: string;
	start: number;
	end: number;
} {
	const [hostPath, binding] = candidatePath.split("#");
	const path = pathIn(root, hostPath ?? "");
	const host = readFileSync(path, "utf8");
	if (!binding) return { path, source: host, host, start: 0, end: host.length };
	if (binding !== "PYTHON_DRIVER") return fail("schema", "Unsupported virtual binding");
	const source = ts.createSourceFile(path, host, ts.ScriptTarget.Latest, true);
	const bindings: ts.TaggedTemplateExpression[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText(source) === binding &&
			node.initializer &&
			ts.isTaggedTemplateExpression(node.initializer)
		)
			bindings.push(node.initializer);
		ts.forEachChild(node, visit);
	}
	visit(source);
	const init = bindings[0];
	if (
		bindings.length !== 1 ||
		!init ||
		init.tag.getText(source) !== "String.raw" ||
		!ts.isNoSubstitutionTemplateLiteral(init.template) ||
		init.template.rawText === undefined
	)
		return fail("schema", "Virtual source is not a unique raw template");
	return { path, source: init.template.rawText, host, start: init.getStart(source), end: init.end };
}
function writeMutation(source: ReturnType<typeof mutationSource>, content: string): void {
	writeFileSync(
		source.path,
		source.start === 0 && source.end === source.host.length
			? content
			: replace(source.host, source.start, source.end, JSON.stringify(content)),
	);
}
async function pythonWorker(
	options: Options,
	source: string,
	directory: string,
	mode: string,
	site?: Site,
	marker?: string,
	sites?: string,
): Promise<ProcessReceipt> {
	const input = join(directory, "python-input.py");
	writeFileSync(input, source);
	return await execute(
		[
			options.python,
			join(import.meta.dir, "quality-mutation/python-engine.py"),
			"--source",
			input,
			"--decision",
			options.decision,
			"--mode",
			mode,
			...(site && marker
				? ["--start", String(site.start), "--end", String(site.end), "--marker", marker]
				: []),
			...(mode === "reach" && sites ? ["--sites", sites] : []),
		],
		directory,
		options.timeout,
	);
}
function probeKey(
	candidate: Candidate,
	instrumentedSource: string,
	options: Options,
	tests: string[],
): string {
	return sha256(JSON.stringify({
		path: candidate.path,
		sourceSha256: candidate.sourceSha256,
		site: candidate.site,
		instrumentedSourceSha256: sha256(instrumentedSource),
		testsSha256: sha256(JSON.stringify(tests)),
		contractSha256: options.contractHash,
		inventorySha256: options.inventoryHash,
		decisionSha256: options.decisionHash,
		inventoryToolSha256: options.inventoryToolHash,
		runtime: {
			bun: Bun.version,
			node: process.execPath,
			typescript: ts.version,
			python: options.python
				? (() => {
					const executable = Bun.which(options.python) ?? options.python;
					return existsSync(executable) ? sha256(readFileSync(executable)) : executable;
				})()
				: "",
			mode: candidate.site.mode,
		},
	}));
}
async function runCandidate(
	candidate: Candidate,
	options: Options,
	contract: Contract,
	temporary: string,
	tests: string[],
	reachMap: Map<string, ProbeEvidence>,
): Promise<Result> {
	const result = defaultResult(candidate, tests);
	const python = candidate.operator.startsWith("py-");
	const evidence = reachMap.get(candidate.id);
	const frozenSource = mutationSource(join(temporary, "frozen"), candidate.path);
	const frozenSourceSha256 = sha256(frozenSource.host);
	const probeCache = new Map<string, ProbeEvidence>();
	result.coverage = evidence ?? null;
	if (!python && !evidence?.reached) {
		result.coverage = evidence ?? { reached: false, markerSha256: sha256(""), tests: [] };
		result.restored = sha256(mutationSource(join(temporary, "frozen"), candidate.path).host) === frozenSourceSha256;
		result.outcome = "noCoverage";
		result.reason = "original-runtime-site-not-reached";
		return result;
	}
	const run = join(temporary, "candidate");
	const root = join(run, "source");
	mkdirSync(run, { recursive: true });
	let original = "";
	let path = "";
	async function checkMutation(mutated: string, python: boolean): Promise<boolean> {
		if (python) {
			const compiled = await pythonWorker(options, mutated, run, "compile");
			result.receipts.push(compiled);
			if (broken(compiled) || ![0, 1].includes(compiled.exitCode ?? -1)) {
				result.outcome = "infrastructure";
				result.reason = "python-compiler-process";
				return false;
			}
			if (object(decode(compiled.stdout)).valid !== true) {
				result.typecheck = "invalid";
				result.outcome = "invalid";
				result.reason = "python-compiler-diagnostics";
				return false;
			}
		}
		const contractPath = join(run, "contract.json");
		writeFileSync(contractPath, JSON.stringify({ ...contract, version: 1, typescript: "5.9.2" }));
		const checked = await execute(
			[
				process.execPath,
				"--smol",
				import.meta.path,
				"--typecheck-root",
				root,
				"--contract",
				contractPath,
				"--inventory",
				options.inventory,
			],
			root,
			options.timeout * Math.max(1, contract.projects.length),
		);
		result.receipts.push(checked);
		if (broken(checked) || ![0, 1].includes(checked.exitCode ?? -1)) {
			result.outcome = "infrastructure";
			result.reason = "typecheck-process";
			return false;
		}
		const check = object(decode(checked.stdout));
		if (check.kind !== "typecheck" || typeof check.valid !== "boolean")
			return fail("infrastructure", "Missing compiler receipt");
		result.typecheck = check.valid ? "valid" : "invalid";
		if (!check.valid) {
			result.outcome = "invalid";
			result.reason = "compiler-diagnostics";
			return false;
		}
		return true;
	}
	async function probeCandidate(
		source: ReturnType<typeof mutationSource>,
		python: boolean,
	): Promise<boolean> {
		const marker = join(run, "hit");
		let probedSource = "";
		if (python) {
			const instrumented = await pythonWorker(
				options,
				source.source,
				run,
				"probe",
				candidate.site,
				marker,
			);
			result.receipts.push(instrumented);
			if (broken(instrumented) || instrumented.exitCode !== 0) {
				result.outcome = "infrastructure";
				result.reason = "python-instrumentation-process";
				return false;
			}
			probedSource = text(object(decode(instrumented.stdout)).source);
		} else probedSource = instrument(source.source, [{ id: candidate.id, path: candidate.path, sourceSha256: candidate.sourceSha256, site: candidate.site, tests }], run);
		const key = probeKey(candidate, probedSource, options, tests);
		const cached = probeCache.get(key);
		if (cached) {
			result.coverage = cached;
			if (!cached.reached) {
				result.outcome = "noCoverage";
				result.reason = "original-runtime-site-not-reached";
				return false;
			}
			return true;
		}
		writeMutation(source, probedSource);
		const probe = await runTests(root, tests, options.timeout, run, options.python, options.suiteTimeout);
		result.receipts.push(...probe.batches.map((batch) => batch.process));
		result.junitReports.push(...probe.batches.map((batch) => batch.junit));
		if (!green(probe)) {
			result.outcome = "infrastructure";
			result.reason = "baseline-probe-not-green";
			return false;
		}
		const hit = existsSync(marker) ? readFileSync(marker, "utf8") : "";
		result.coverage = { reached: hit === "1", markerSha256: sha256(hit), tests };
		if (existsSync(marker) && hit !== "1") {
			result.outcome = "infrastructure";
			result.reason = "malformed-coverage-marker";
			return false;
		}
		if (!result.coverage?.reached) {
			// A green, complete selection with no marker is the only reusable
			// proof of an unreached original site. Errors and malformed markers
			// return above without entering the campaign-local cache.
			probeCache.set(key, result.coverage);
			result.outcome = "noCoverage";
			result.reason = "original-runtime-site-not-reached";
			return false;
		}
		probeCache.set(key, result.coverage);
		return true;
	}
	try {
		copyExecution(join(temporary, "frozen"), root);
		const source = mutationSource(root, candidate.path);
		path = source.path;
		original = source.host;
		if (sha256(source.source) !== candidate.sourceSha256)
			return fail("tamper", "Candidate snapshot drift");
		const mutated = replace(
			source.source,
			candidate.startOffset,
			candidate.endOffset,
			candidate.replacement,
		);
		writeMutation(source, mutated);
		if (!(await checkMutation(mutated, python))) return result;
		if (python && !(await probeCandidate(source, python))) return result;
		// TypeScript reach was established once for the campaign.
		// Test side effects cannot leak into the mutation run.
		removeExecution(root);
		copyExecution(join(temporary, "frozen"), root);
		writeMutation(source, mutated);
		const tested = await runTests(root, tests, options.timeout, run, options.python, options.suiteTimeout);
		result.receipts.push(...tested.batches.map((batch) => batch.process));
		result.junitReports.push(...tested.batches.map((batch) => batch.junit));
		if (green(tested)) {
			result.outcome = "survived";
			result.reason = "green-mutated-test-selection";
		} else if (
			tested.valid &&
			tested.exitCode === 1 &&
			tested.failures > 0 &&
			tested.assertions.length === tested.failures
		) {
			result.outcome = "killed";
			result.reason = "behavioral-assertion";
			result.assertionIdentities = tested.assertions;
		} else {
			result.outcome = "infrastructure";
			result.reason = "failure-without-complete-behavioral-assertions";
		}
		return result;
	} catch {
		result.outcome = "infrastructure";
		result.reason = failure?.code ?? "candidate-filesystem-or-process-failure";
		return result;
	} finally {
		if (path && original && existsSync(dirname(path))) {
			writeFileSync(path, original);
			result.restored = sha256(readFileSync(path)) === frozenSourceSha256;
		}
		removeExecution(root);
		rmSync(run, { recursive: true, force: true });
	}
}
function argumentsMap(argv: string[]): Map<string, string[]> {
	const values = new Map<string, string[]>();
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (!key?.startsWith("--")) return fail("arguments", "Expected named arguments");
		const value = key === "--pilot" ? "true" : argv[++index];
		if (!value || value.startsWith("--")) return fail("missingInput", `Missing ${key} value`);
		values.set(key, [...(values.get(key) ?? []), value]);
	}
	return values;
}
function optionsFrom(values: Map<string, string[]>): Options {
	const names = [
		"root",
		"contract",
		"inventory",
		"decision",
		"inventory-tool",
		"contract-sha256",
		"inventory-sha256",
		"decision-sha256",
		"inventory-tool-sha256",
		"dependencies",
		"python",
		"test",
		"target",
		"operator",
		"limit",
		"max-candidates",
		"timeout",
		"suite-timeout",
		"budget",
		"pilot",
	];
	for (const [key, entries] of values)
		if (
			!names.includes(key.slice(2)) ||
			(entries.length > 1 && !["--test", "--target", "--operator"].includes(key))
		)
			return fail("arguments", `Unsupported or duplicate argument ${key}`);
	function required(key: string): string {
		return values.get(`--${key}`)?.[0] ?? fail("missingInput", `Required --${key}`);
	}
	function bound(key: string, fallback: number, maximum: number): number {
		const value = Number(values.get(`--${key}`)?.[0] ?? fallback);
		if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
			return fail("arguments", `Invalid --${key}`);
		return value;
	}
	return {
		root: realpathSync(required("root")),
		contract: resolve(required("contract")),
		inventory: resolve(required("inventory")),
		decision: resolve(required("decision")),
		inventoryTool: resolve(required("inventory-tool")),
		contractHash: required("contract-sha256"),
		inventoryHash: required("inventory-sha256"),
		decisionHash: required("decision-sha256"),
		inventoryToolHash: required("inventory-tool-sha256"),
		dependencies: realpathSync(required("dependencies")),
		python: values.get("--python")?.[0] ?? Bun.which("python3") ?? "",
		tests: values.get("--test") ?? [],
		targets: values.get("--target") ?? [],
		families: values.get("--operator") ?? [],
		limit: bound("limit", 1000000, 1000000),
		maxCandidates: bound("max-candidates", 10000, 1000000),
		timeout: bound("timeout", 15000, 15000),
		suiteTimeout: bound("suite-timeout", 15000, 3600000),
		budget: bound("budget", 3600000, 604800000),
		pilot: ["--pilot", "--limit", "--test", "--target", "--operator"].some((key) =>
			values.has(key),
		),
	};
}
async function canonicalVerification(options: Options): Promise<ProcessReceipt> {
	pinned(options.inventoryTool, options.inventoryToolHash);
	const receipt = await execute(
		[
			process.execPath,
			options.inventoryTool,
			"--root",
			options.root,
			"--contract",
			options.contract,
			"--inventory",
			options.inventory,
		],
		options.root,
		options.timeout,
	);
	if (broken(receipt) || receipt.exitCode !== 0)
		return fail(
			"incompleteInventory",
			`Canonical inventory verification failed: ${receipt.stderr.slice(0, 2000)}`,
		);
	if (JSON.stringify(decode(receipt.stdout)) !== JSON.stringify(readJson(options.inventory)))
		return fail("incompleteInventory", "Canonical verification returned a different inventory");
	return receipt;
}
async function enumeratePython(
	options: Options,
	temporary: string,
	frozen: string,
	enumerated: ReturnType<typeof enumerate>,
) {
	const python = object(object(object(readJson(options.decision)).contract).embeddedPython);
	const pythonFamilies = array(object(python.mutation).operators).map((value) =>
		text(object(value).id),
	);
	if (
		sha256(JSON.stringify(python.mutation)) !==
		"072579aa17fe6dd80df6fd0085a9c6bdffec66a3510edc035e30f067d4968331"
	)
		return fail(
			"operatorContract",
			"Python operator definitions differ from frozen d945-python-mutation@1",
		);
	const pythonRows = enumerated.census.filter(
		(row) => row.language === "python" && row.category !== "historical",
	);
	const pythonReceipts: ProcessReceipt[] = [];
	const pythonCapability = pythonRows.length
		? {
			implemented: true,
			algorithm: "d945-python-mutation@1",
			requiredVersion: text(object(python.runtime).version),
			executable: options.python,
			executableSha256: options.python ? sha256(readFileSync(options.python)) : "",
			engineSha256: sha256(
				readFileSync(join(import.meta.dir, "quality-mutation/python-engine.py")),
			),
			probe: await execute([options.python, "--version"], temporary, options.timeout),
			receipts: pythonReceipts,
		}
		: null;
	for (const row of pythonRows) {
		const source = mutationSource(frozen, row.path);
		if (sha256(source.source) !== row.sha256)
			return fail("tamper", `Python source drift: ${row.path}`);
		const parsed = await pythonWorker(options, source.source, temporary, "enumerate");
		pythonReceipts.push(parsed);
		const data =
			!broken(parsed) && [0, 1].includes(parsed.exitCode ?? -1)
				? object(decode(parsed.stdout))
				: null;
		row.syntax = data?.valid === true ? "parsed" : "python-analysis-error";
		if (row.syntax !== "parsed")
			enumerated.errors.push(`${row.path}: Python parser/runtime failure`);
		row.astNodes = data?.astNodes === undefined ? 0 : number(data.astNodes);
		const candidates =
			data?.valid === true
				? array(data.candidates).map((value): Candidate => {
					const item = object(value);
					const site = object(item.site);
					const mode = text(site.mode);
					if (mode !== "python-expression" && mode !== "python-statement")
						return fail("schema", "Invalid Python probe mode");
					const replacement = text(item.replacement);
					const startOffset = number(item.startOffset);
					const endOffset = number(item.endOffset);
					const replacementSha256 = sha256(replacement);
					const operator = text(item.operator);
					if (
						!pythonFamilies.includes(operator) ||
						endOffset > source.source.length ||
						startOffset >= endOffset
					)
						return fail("schema", "Invalid Python candidate");
					return {
						id: sha256(`${row.path}\0${startOffset}\0${endOffset}\0${replacementSha256}`),
						path: row.path,
						sourceSha256: row.sha256,
						startOffset,
						endOffset,
						operator,
						replacement,
						replacementSha256,
						site: { start: number(site.start), end: number(site.end), mode },
					};
				})
				: [];
		enumerated.candidates.push(...candidates);
		row.operators = pythonFamilies.map((operator) => {
			const count = candidates.filter((candidate) => candidate.operator === operator).length;
			return {
				operator,
				candidates: count,
				reason: count
					? "enumerated"
					: row.syntax === "parsed"
						? "no-applicable-runtime-AST-site"
						: row.syntax,
			};
		});
	}
	return pythonCapability;
}

function selectedCandidates(options: Options, candidates: Candidate[]): Candidate[] {
	return candidates.filter((candidate) =>
		(!options.targets.length || options.targets.includes(candidate.path)) &&
		(!options.families.length || options.families.includes(candidate.operator)),
	).slice(0, options.pilot ? options.limit : undefined);
}
async function executeSelection(
	options: Options,
	contract: Contract,
	temporary: string,
	started: number,
	enumerated: ReturnType<typeof enumerate>,
	tests: string[],
	errors: string[],
	reachMap: Map<string, ProbeEvidence>,
): Promise<Result[]> {
	const results: Result[] = [];
	const selected = selectedCandidates(options, enumerated.candidates);
	if (!selected.length) errors.push("zero selected candidates");
	const selectedIds = new Set(selected.map((candidate) => candidate.id));
	let executed = 0;
	for (const candidate of enumerated.candidates) {
		if (!selectedIds.has(candidate.id)) results.push(defaultResult(candidate, tests, false));
		else if (
			errors.length ||
			executed >= options.maxCandidates ||
			Date.now() - started >= options.budget
		)
			results.push(defaultResult(candidate, tests));
		else {
			console.error(`[mutation] mutant ${executed + 1}/${selected.length} start ${candidate.path}:${candidate.startOffset} ${candidate.operator}`);
			const result = await runCandidate(candidate, options, contract, temporary, reachMap.get(candidate.id)?.tests ?? tests, reachMap);
			results.push(result);
			executed++;
			console.error(`[mutation] mutant ${executed}/${selected.length} ${result.outcome}: ${result.reason}`);
		}
	}
	return results;
}

function campaignOutcome(
	options: Options,
	enumerated: ReturnType<typeof enumerate>,
	results: Result[],
	errors: string[],
	cleanupVerified: boolean,
) {
	const counts = {
		killed: 0,
		survived: 0,
		noCoverage: 0,
		invalid: 0,
		infrastructure: 0,
		uncompleted: 0,
	};
	for (const result of results) counts[result.outcome]++;
	const selectedCounts = {
		killed: 0,
		survived: 0,
		noCoverage: 0,
		invalid: 0,
		infrastructure: 0,
		uncompleted: 0,
	};
	for (const result of results.filter((result) => result.selected))
		selectedCounts[result.outcome]++;
	const valid = counts.killed + counts.survived + counts.noCoverage;
	const complete =
		errors.length === 0 &&
		counts.infrastructure === 0 &&
		selectedCounts.uncompleted === 0 &&
		valid > 0 &&
		results.every((result) => result.restored) &&
		cleanupVerified;
	const exitCode = !complete ? 2 : counts.survived > 0 || counts.noCoverage > 0 ? 1 : 0;
	const full = !options.pilot && counts.uncompleted === 0 && enumerated.errors.length === 0;
	return { counts, selectedCounts, complete, exitCode, full };
}

async function campaign(options: Options): Promise<number> {
	pinned(options.contract, options.contractHash);
	pinned(options.inventory, options.inventoryHash);
	pinned(options.decision, options.decisionHash);
	const contract = contractAt(options.contract);
	const inventory = inventoryAt(options.inventory);
	for (const project of contract.projects)
		if (!inventory.configurations.some((file) => file.path === project))
			return fail(
				"incompleteInventory",
				`Compiler project is not hash-pinned in inventory: ${project}`,
			);
	const operators = operatorsAt(options.decision);
	console.error("[mutation] verifying canonical inventory");
	const canonical = await canonicalVerification(options);
	verifySources(options.root, inventory);
	const temporary = mkdtempSync(join(tmpdir(), "omo-quality-mutation-"));
	const started = Date.now();
	let cleanupVerified = false;
	try {
		const frozen = join(temporary, "frozen");
		console.error(`[mutation] creating frozen execution copy at ${frozen}`);
		snapshot(options, frozen);
		console.error("[mutation] hashing frozen execution copy");
		const executionTreeSha256 = executionTreeHash(frozen);
		const base = join(temporary, "baseline");
		console.error(`[mutation] enumerating and checking ${contract.projects.length} compiler projects sequentially`);
		const { enumerated, sourceDiagnostics } = analyze(frozen, contract, inventory, operators);
		Bun.gc(true); // Release compiler AST/checkers before test children run.
		console.error(`[mutation] enumerating Python candidates (${enumerated.candidates.length} TS/JS candidates)`);
		const pythonCapability = await enumeratePython(options, temporary, frozen, enumerated);
		enumerated.candidates.sort(compareCandidates);
		console.error(`[mutation] compiler analysis finished (${enumerated.candidates.length} candidates, ${sourceDiagnostics.length} diagnostics)`);
		const tests = options.tests.length
			? options.tests
			: inventory.files
				.filter(
					(file) =>
						file.category === "test" &&
						["typescript", "javascript"].includes(file.language) &&
						/\.(test|spec)\.[cm]?[jt]sx?$/.test(file.path),
				)
				.map((file) => file.path);
		for (const test of tests)
			if (!inventory.files.some((file) => file.path === test))
				return fail("incompleteInventory", `Test absent from inventory: ${test}`);
		const errors = [...enumerated.errors];
		if (!tests.length) errors.push("zero test selection");
		if (sourceDiagnostics.length)
			errors.push(`baseline compiler rejected ${sourceDiagnostics.length} diagnostics`);
		if (!enumerated.candidates.length) errors.push("zero eligible mutation candidates");
		console.error(`[mutation] baseline execution copy (${tests.length} test files, ${errors.length} errors)`);
		if (!errors.length) copyExecution(frozen, base);
		console.error("[mutation] baseline tests starting");
		const baseline = errors.length
			? null
			: await runTests(base, tests, options.timeout, temporary, options.python, options.suiteTimeout);
		if (baseline && !green(baseline)) errors.push("baseline test selection is not green");
		console.error(`[mutation] baseline tests finished: ${JSON.stringify(baseline ? { tests: baseline.tests, failures: baseline.failures, exitCode: baseline.exitCode, processes: baseline.batches.map((batch) => ({ exitCode: batch.process.exitCode, signal: batch.process.signal, timedOut: batch.process.timedOut })) } : { errors })}`);
		const selected = selectedCandidates(options, enumerated.candidates);
		const reachCandidates = selected.filter((candidate) => !candidate.operator.startsWith("py-"));
		const reach = errors.length ? { map: new Map<string, ProbeEvidence>(), receipt: null } : await buildReachMap(options, frozen, temporary, reachCandidates, tests, executionTreeSha256);
		removeExecution(join(temporary, "reach"));
		const results = await executeSelection(
			options, contract, temporary, started, enumerated, tests, errors, reach.map,
		);
		console.error("[mutation] verifying restoration and cleaning execution copies");
		verifySources(options.root, inventory);
		if (executionTreeHash(frozen) !== executionTreeSha256)
			return fail("tamper", "Frozen execution copy changed");
		await canonicalVerification(options);
		pinned(options.contract, options.contractHash);
		pinned(options.inventory, options.inventoryHash);
		pinned(options.decision, options.decisionHash);
		removeExecution(base);
		removeExecution(frozen);
		rmSync(temporary, { recursive: true, force: true });
		cleanupVerified = !existsSync(temporary);
		const { counts, selectedCounts, complete, exitCode, full } = campaignOutcome(
			options, enumerated, results, errors, cleanupVerified,
		);
		console.error(`[mutation] campaign finished: ${JSON.stringify({ counts, selectedCounts, complete, errors })}`);
		console.log(
			JSON.stringify({
				version: 1,
				algorithm: "d945-mutation@1",
				exitCode,
				full,
				complete,
				globalZero: false,
				mutationZero: full && exitCode === 0,
				counts,
				selectedCounts,
				errors,
				executionTreeSha256,
				pythonCapability,
				testSelections: [{ id: sha256(JSON.stringify(tests)), paths: tests }],
				reachMap: reach.receipt,
				sourceDiagnostics,
				sourceDiagnosticsSha256: sha256(JSON.stringify(sourceDiagnostics)),
				inventorySha256: options.inventoryHash,
				contractSha256: options.contractHash,
				decisionSha256: options.decisionHash,
				inventoryToolSha256: options.inventoryToolHash,
				runnerSha256: sha256(readFileSync(import.meta.path)),
				runtime: {
					version: Bun.version,
					path: process.execPath,
					sha256: sha256(readFileSync(process.execPath)),
					typescript: ts.version,
					compilerSha256: sha256(readFileSync(require.resolve("typescript"))),
				},
				canonical,
				baseline,
				census: enumerated.census,
				results,
				originalHashesVerified: true,
				cleanupVerified,
			}),
		);
		return exitCode;
	} finally {
		if (!cleanupVerified) {
			removeExecution(join(temporary, "candidate/source"));
			removeExecution(join(temporary, "baseline"));
			removeExecution(join(temporary, "frozen"));
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
	failure = null;
	try {
		if (!["1.3.6", "1.4.1"].includes(Bun.version) || ts.version !== "5.9.2")
			return fail(
				"toolVersion",
				"Requires Bun 1.3.6 (or explicit current compatibility 1.4.1) and TypeScript 5.9.2",
			);
		const values = argumentsMap(argv);
		if (values.has("--typecheck-root")) {
			const root =
				values.get("--typecheck-root")?.[0] ?? fail("arguments", "Missing typecheck root");
			const contract =
				values.get("--contract")?.[0] ?? fail("arguments", "Missing typecheck contract");
			const inventory =
				values.get("--inventory")?.[0] ?? fail("arguments", "Missing typecheck inventory");
			const errors = diagnostics(programs(root, contractAt(contract), inventoryAt(inventory)));
			console.log(
				JSON.stringify({
					kind: "typecheck",
					valid: errors.length === 0,
					diagnostics: errors,
					diagnosticsSha256: sha256(JSON.stringify(errors)),
				}),
			);
			return errors.length ? 1 : 0;
		}
		return await campaign(optionsFrom(values));
	} catch (error) {
		const caught = error instanceof Error ? error.message : String(error);
		const prior = failure as { code: string; message: string } | null;
		failure = { code: prior?.code ?? "infrastructure", message: `${prior?.message ?? ""}${prior?.message ? "; " : ""}${caught}` };
		console.log(
			JSON.stringify({
				version: 1,
				exitCode: 2,
				full: false,
				complete: false,
				globalZero: false,
				error: failure ?? {
					code: "infrastructure",
					message: "Unhandled filesystem, compiler or process failure",
				},
			}),
		);
		return 2;
	}
}
if (import.meta.main) process.exitCode = await main();
