/** Strict, inventory-consuming coverage path for the existing coverage owner.
 * No source discovery, percentages, exclusions, baseline or update operation.
 * Collection and verification regenerate the same pinned executable maps.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	openSync,
	writeSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, constants as osConstants } from "node:os";
import nativeProcesses from "node:child_process";
import * as nodeModules from "node:module";
import { installProcessHooks } from "./quality-coverage/node";
const analyzerNative: {
	spawnSync(binary: string, args: string[], options: { input?: string; encoding: "utf8"; timeout: number }): {
		status: number | null; stdout: string; stderr: string; signal: string | null;
	};
} = nativeProcesses;
const nativeSpawnSync = analyzerNative.spawnSync;
const nativeBunSpawnSync = typeof Bun === "undefined" ? undefined : Bun.spawnSync;
function analyzerProcess(binary: string, args: string[], input?: string): { status: number | null; stdout: string; stderr: string; signal: string | null } {
	if (nativeBunSpawnSync) {
		const result = nativeBunSpawnSync([binary, ...args], { stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe", timeout: 120_000 });
		return { status: result.signalCode ? null : result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), signal: signalName(result.signalCode) };
	}
	const result = nativeSpawnSync(binary, args, { input, encoding: "utf8", timeout: 120_000 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", signal: result.signal };
}
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as istanbul from "istanbul-lib-instrument";
import type { FileCoverageData, Location, Range } from "istanbul-lib-coverage";
import * as mapping from "@jridgewell/trace-mapping";

// Structural dependency ports expose only the consumed API. No dependency
// declaration edits, casts, or opaque parser/plugin payloads enter the analyzer.
const instrument: {
	createInstrumenter(options: {
		coverageVariable: string; coverageGlobalScope: string; coverageGlobalScopeFunc: boolean;
		esModules: boolean; compact: boolean; preserveComments: boolean;
		produceSourceMap: boolean; ignoreClassMethods: string[];
	}): { instrumentSync(code: string, path: string): string; lastFileCoverage(): FileCoverageData };
} = istanbul;
type SourceMapView = {
	version: number; file: string | null | undefined; names: string[]; sourceRoot: string | undefined;
	sources: (string | null)[]; sourcesContent: (string | null)[] | undefined;
	ignoreList: number[] | undefined; resolvedSources: string[];
};
const sourceMapping: {
	TraceMap: new (source: string) => SourceMapView;
	originalPositionFor(map: SourceMapView, position: Location): {
		source: string | null; line: number | null; column: number | null; name: string | null;
	};
} = mapping;

type Json = null | boolean | string | number | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Counts = { [key: string]: number };
type Dimensions = "statements" | "branches" | "functions" | "lines";
type Metric = { total: number; covered: number; notApplicable: boolean };
type Finding = { class: Dimensions; path: string; line: number; symbol: string };
type Entry = { path: string; sha256: string; bytes: number; category: string; language: string };
type Prepared = {
	entry: Entry;
	code: string;
	mapHash: string;
	coverage: FileCoverageData;
	mapped: FileCoverageData;
	python?: { source: string; lines: number[]; arcs: Json };
};
type Fault = {
	id: string; command: string; entry: string; args: string[];
	exitCode: number | null; signal: string | null; occurrences: number;
	checkpoint: { path: string; statement: string; minimumHits: number };
};
type Command = {
	id: string;
	kind: string;
	paths: string[];
	args: string[];
	expectedExitCode: number;
	runtime?: string;
};
type Options = {
	root: string;
	contract: string;
	contractHash: string;
	inventory: string;
	inventoryHash: string;
	plan: string;
	planHash: string;
};
type Inputs = {
	options: Options;
	entries: Entry[];
	files: Prepared[];
	commands: Command[];
	roots: string[];
	faults: Fault[];
};
type ProcessReceipt = {
	id: string;
	parent: string;
	pid: number;
	exitCode: number | null;
	signal: string | null;
	runtime: string;
	entry: string;
	args: string[];
	command: string;
	lines: { [key: string]: Counts };
	trace: ObjectValue | null;
	children: string[];
	loaded: string[];
	coverage: { [key: string]: FileCoverageData };
};
declare global {
	var __d945Coverage: { [key: string]: FileCoverageData } | undefined;
}

class CoverageError {
	constructor(
		readonly code: string,
		readonly path: string,
		readonly message: string,
	) { }
}
let lastFailure: CoverageError | undefined;
function fail(code: string, path: string, message: string): never {
	lastFailure = new CoverageError(code, path, message);
	if (process.env.D945_DIRECTORY && process.env.D945_PROCESS)
		writeFileSync(
			join(process.env.D945_DIRECTORY, `${process.env.D945_PROCESS}.failure.json`),
			JSON.stringify(lastFailure),
		);
	throw lastFailure;
}
export function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

// Strict JSON at the external boundary: no top-typed JSON.parse payload, duplicate
// object keys, non-finite numbers, trailing data, or prototype mutation.
export function decode(text: string): Json {
	let i = 0;
	const ws = () => {
		while (/\s/.test(text[i] ?? "") && i < text.length) i++;
	};
	function escapedCharacter(): string {
		const escapeCode = text[i++];
		if (escapeCode === "u") {
			const hex = text.slice(i, i + 4);
			if (!/^[a-fA-F0-9]{4}$/.test(hex)) fail("schema", "", "invalid Unicode escape");
			i += 4;
			return String.fromCharCode(Number.parseInt(hex, 16));
		}
		const escapes: Record<string, string> = {
			'"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
		};
		if (!escapeCode || !(escapeCode in escapes)) fail("schema", "", "invalid escape");
		return escapes[escapeCode] ?? fail("schema", "", "invalid escape");
	}
	function string(): string {
		if (text[i++] !== '"') fail("schema", "", "expected string");
		let result = "";
		while (i < text.length) {
			const c = text[i++];
			if (c === '"') return result;
			if (c === "\\") {
				result += escapedCharacter();
			} else {
				if (!c || c.charCodeAt(0) < 32) fail("schema", "", "invalid string");
				result += c;
			}
		}
		return fail("schema", "", "unterminated string");
	}
	function container(c: "[" | "{"): Json {
		i++;
		ws();
		const close = c === "[" ? "]" : "}";
		const array: Json[] = [];
		const entries = new Map<string, Json>();
		if (text[i] !== close)
			for (; ;) {
				if (c === "[") array.push(value());
				else {
					ws();
					const key = string();
					ws();
					if (entries.has(key) || text[i++] !== ":")
						fail("schema", "", "duplicate key or missing colon");
					entries.set(key, value());
				}
				ws();
				if (text[i] !== ",") break;
				i++;
			}
		if (text[i++] !== close) fail("schema", "", "unterminated container");
		return c === "[" ? array : Object.fromEntries(entries);
	}
	function value(): Json {
		ws();
		const c = text[i];
		if (c === '"') return string();
		if (c === "[" || c === "{") return container(c);
		for (const [token, literal] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (text.startsWith(token, i)) {
				i += token.length;
				return literal;
			}
		}
		const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
		if (!number || !Number.isFinite(Number(number[0])))
			return fail("schema", "", "invalid JSON value");
		i += number[0].length;
		return Number(number[0]);
	}
	const result = value();
	ws();
	if (i !== text.length) fail("schema", "", "trailing JSON data");
	return result;
}
function object(value: Json | undefined, keys?: string[]): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail("schema", "", "expected object");
	if (
		keys &&
		(Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
	)
		fail("schema", "", "object keys differ");
	return value;
}
function text(value: Json | undefined): string {
	if (typeof value !== "string") return fail("schema", "", "expected string");
	return value;
}
function integer(value: Json | undefined): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		return fail("integer", "", "expected nonnegative safe integer");
	return value;
}
function array(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) return fail("schema", "", "expected array");
	return value;
}
function choice(value: Json | undefined, choices: string[]): string {
	const result = text(value);
	if (!choices.includes(result)) fail("schema", "", "invalid enum");
	return result;
}
function pathValue(value: Json | undefined): string {
	const path = text(value);
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((p) => !p || p === "." || p === "..")
	)
		fail("path", path, "noncanonical path");
	return path;
}
function hash(value: Json | undefined): string {
	const result = text(value);
	if (!/^[a-f0-9]{64}$/.test(result)) fail("hash", "", "expected sha256");
	return result;
}
function content(root: string, path: string): Buffer {
	const absolute = resolve(root, path);
	if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isFile())
		fail("identity", path, "source must be a regular nonsymlink file");
	return readFileSync(absolute);
}
function frozen(path: string, expected: string): Json {
	const bytes = readFileSync(path);
	if (sha256(bytes) !== hash(expected)) fail("tamper", path, "frozen input hash differs");
	return decode(bytes.toString("utf8"));
}
function entry(value: Json): Entry {
	const v = object(value, ["path", "sha256", "bytes", "category", "language"]);
	return {
		path: pathValue(v.path),
		sha256: hash(v.sha256),
		bytes: integer(v.bytes),
		category: choice(v.category, [
			"production",
			"tooling",
			"test",
			"fixture",
			"benchmark",
			"migration",
			"historical",
		]),
		language: choice(v.language, ["typescript", "javascript", "python", "sql"]),
	};
}
function unique(paths: string[], kind: string): void {
	if (new Set(paths).size !== paths.length) fail("inventory", "", `duplicate ${kind}`);
}

function toolchain() {
	return [
		["typescript", "5.9.2"],
		["istanbul-lib-instrument", "6.0.3"],
		["istanbul-lib-coverage", "3.2.2"],
		["istanbul-lib-source-maps", "5.0.6"],
		["@jridgewell/trace-mapping", "0.3.31"],
	].map(([name = "", version = ""]) => {
		const packageUrl = name === "istanbul-lib-source-maps" ? import.meta.resolve("istanbul-lib-source-maps/package.json") : import.meta.resolve(`${name}/package.json`);
		const packageBytes = readFileSync(fileURLToPath(packageUrl));
		if (object(decode(packageBytes.toString("utf8"))).version !== version)
			fail("toolchain", name, "installed version differs from pin");
		return {
			name,
			version,
			packageSha256: sha256(packageBytes),
			entrySha256: sha256(readFileSync(fileURLToPath(import.meta.resolve(name)))),
		};
	});
}

function commands(value: Json, entries: Entry[]): Command[] {
	const plan = object(value);
	object(value, plan.version === 2 ? ["version", "commands", "faults"] : ["version", "commands"]);
	if (plan.version !== 1 && plan.version !== 2) fail("schema", "", "unsupported plan version");
	const result = array(plan.commands).map((item) => {
		const v = object(item);
		object(item, ["id", "kind", "paths", "args", "expectedExitCode", ...(v.runtime === undefined ? [] : ["runtime"])]);
		const command = {
			id: text(v.id),
			kind: choice(v.kind, ["test", "cli"]),
			paths: array(v.paths).map(pathValue),
			args: array(v.args).map(text),
			expectedExitCode: integer(v.expectedExitCode),
			runtime: v.runtime === undefined ? "bun" : choice(v.runtime, ["bun", "node", "python"]),
		};
		if (
			!/^[a-zA-Z0-9_-]+$/.test(command.id) ||
			!command.paths.length ||
			command.expectedExitCode > 255
		)
			fail("plan", "", "invalid command");
		if (command.kind === "cli" && command.paths.length !== 1)
			fail("plan", command.id, "CLI requires one entry");
		for (const path of command.paths)
			if (!entries.some((e) => e.path === path))
				fail("plan", path, "entry outside frozen inventory");
		if (command.kind === "test" && (command.runtime !== "bun" || command.args.length || command.expectedExitCode !== 0))
			fail("plan", command.id, "test filtering or failure credit is forbidden");
		return command;
	});
	unique(
		result.map((c) => c.id),
		"command",
	);
	if (!result.length) fail("plan", "", "empty command selection");
	for (const e of entries.filter(
		(e) => e.category === "test" && /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.path),
	)) {
		if (!result.some((c) => c.kind === "test" && c.paths.includes(e.path)))
			fail("plan", e.path, "missing test entry");
	}
	return result;
}

function nullableExit(value: Json | undefined): number | null {
	return value === null ? null : integer(value);
}
function nullableSignal(value: Json | undefined): string | null {
	return value === null ? null : choice(value, Object.keys(osConstants.signals));
}
function faultContracts(value: Json, commands: Command[], files: Prepared[]): Fault[] {
	const plan = object(value);
	const faults = plan.version === 2 ? array(plan.faults).map((item): Fault => {
		const f = object(item, ["id", "command", "entry", "args", "exitCode", "signal", "occurrences", "checkpoint"]);
		const checkpoint = object(f.checkpoint, ["path", "statement", "minimumHits"]);
		const result = {
			id: text(f.id), command: text(f.command), entry: pathValue(f.entry), args: array(f.args).map(text),
			exitCode: nullableExit(f.exitCode), signal: nullableSignal(f.signal), occurrences: integer(f.occurrences),
			checkpoint: { path: pathValue(checkpoint.path), statement: text(checkpoint.statement), minimumHits: integer(checkpoint.minimumHits) },
		};
		if (!commands.some((c) => c.id === result.command) || !files.some((f) => f.entry.path === result.entry) ||
			result.occurrences < 1 || result.checkpoint.minimumHits < 1 ||
			(result.exitCode === null) === (result.signal === null) || result.exitCode === 0 ||
			!files.some((f) => f.entry.path === result.checkpoint.path && Object.hasOwn(f.coverage.s, result.checkpoint.statement)))
			fail("plan", result.id, "invalid approved fault boundary");
		return result;
	}) : [];
	unique(faults.map((f) => f.id), "fault contract");
	unique(faults.map((f) => JSON.stringify([f.command, f.entry, f.args, f.exitCode, f.signal])), "fault selector");
	return faults;
}
function syntax(source: string, path: string): void {
	const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const callee = node.expression.getText(sf);
			if (
				["eval", "Function", "require"].includes(callee) &&
				(!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
			)
				fail("unsupported_syntax", path, "dynamic code or module loading");
			if (callee === "eval" || callee === "Function")
				fail("unsupported_syntax", path, "dynamic executable source");
			// Dynamic module specifiers are resolved by the actual runtime loader;
			// its onLoad/registerHooks boundary checks the frozen source identity.
		}
		if (ts.isNewExpression(node) && ["Function", "Worker"].includes(node.expression.getText(sf)))
			fail("unsupported_syntax", path, "untracked execution context");
		const moduleArgument =
			ts.isStringLiteral(node) &&
			ts.isCallExpression(node.parent) &&
			(node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
				node.parent.expression.getText(sf) === "require");
		if (
			ts.isStringLiteral(node) &&
			(ts.isImportDeclaration(node.parent) ||
				ts.isExportDeclaration(node.parent) ||
				moduleArgument) &&
			/^(node:)?(worker_threads|cluster|vm)$/.test(node.text)
		)
			fail(
				"unsupported_process",
				path,
				"Node process/context hooks are not supported by the Bun collector",
			);
		if (ts.isTaggedTemplateExpression(node) && /(?:^|\.)\$$/.test(node.tag.getText(sf)))
			fail("unsupported_process", path, "shell process graph is not observable through Bun.spawn");
		ts.forEachChild(node, visit);
	}
	visit(sf);
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (
			(token === ts.SyntaxKind.SingleLineCommentTrivia ||
				token === ts.SyntaxKind.MultiLineCommentTrivia) &&
			/(?:istanbul|c8|v8)\s+ignore|sourceMappingURL/.test(scanner.getTokenText())
		)
			fail("unsupported_syntax", path, "coverage directives and preexisting maps are forbidden");
	}
}

function mapCoverage(
	raw: FileCoverageData,
	sourceMap: string,
	source: string,
	path: string,
): FileCoverageData {
	const map = object(decode(sourceMap));
	if (
		map.version !== 3 ||
		array(map.sources).length !== 1 ||
		text(array(map.sources)[0]) !== basename(path) ||
		array(map.sourcesContent).length !== 1 ||
		text(array(map.sourcesContent)[0]) !== source ||
		(map.sourceRoot !== "" && map.sourceRoot !== undefined)
	)
		fail("source_map", path, "original source identity differs");
	const lines = source.split(/\r?\n/);
	function position(location: Location): Location {
		if (!Number.isInteger(location.line) || !Number.isInteger(location.column))
			return fail("source_map", path, "missing executable position");
		const p = sourceMapping.originalPositionFor(new sourceMapping.TraceMap(sourceMap), location);
		if (
			p.source !== basename(path) ||
			p.line === null ||
			p.column === null ||
			p.line < 1 ||
			p.line > lines.length ||
			p.column > (lines[p.line - 1]?.length ?? 0)
		)
			return fail("source_map", path, "unmapped executable position");
		return { line: p.line, column: p.column };
	}
	function range(r: Range): Range {
		const start = position(r.start);
		const end = position(r.end);
		if (start.line > end.line || (start.line === end.line && start.column > end.column))
			fail("source_map", path, "reversed original range");
		return { start, end };
	}
	const statementMap = Object.fromEntries(
		Object.entries(raw.statementMap).map(([id, r]) => [id, range(r)]),
	);
	const fnMap = Object.fromEntries(
		Object.entries(raw.fnMap).map(([id, f]) => [
			id,
			{ name: f.name, decl: range(f.decl), loc: range(f.loc), line: position(f.loc.start).line },
		]),
	);
	const branchMap = Object.fromEntries(
		Object.entries(raw.branchMap).map(([id, b]) => [
			id,
			{
				type: b.type,
				loc: range(b.loc),
				// Istanbul 6's implicit else is the one deliberately locationless arm.
				// It belongs to the enclosing if, whose original range must still map.
				locations: b.locations.map((r, index) =>
					range(
						b.type === "if" &&
							index === 1 &&
							r.start.line === undefined &&
							r.start.column === undefined &&
							r.end.line === undefined &&
							r.end.column === undefined
							? b.loc
							: r,
					),
				),
				line: position(b.loc.start).line,
			},
		]),
	);
	return {
		path,
		statementMap,
		fnMap,
		branchMap,
		s: { ...raw.s },
		f: { ...raw.f },
		b: Object.fromEntries(Object.entries(raw.b).map(([k, v]) => [k, [...v]])),
	};
}

function asset(path: string): string {
	return join(process.env.D945_ASSET_DIRECTORY ?? join(import.meta.dir, "quality-coverage"), path);
}
function pythonBinary(): string {
	return process.env.D945_PYTHON ?? "python3";
}
function embeddedSource(e: Entry, root: string): string {
	const [host, binding] = e.path.split("#");
	if (!host || !binding || e.path.split("#").length !== 2)
		return fail("inventory", e.path, "invalid virtual source identity");
	const source = content(root, host).toString("utf8");
	const sf = ts.createSourceFile(host, source, ts.ScriptTarget.Latest, true);
	const matches: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === binding) {
			const init = node.initializer;
			if (!init || !ts.isTaggedTemplateExpression(init) || init.tag.getText(sf) !== "String.raw" ||
				!ts.isNoSubstitutionTemplateLiteral(init.template) || init.template.rawText === undefined)
				fail("inventory", e.path, "virtual source is not a raw constant binding");
			matches.push(init.template.rawText);
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	if (matches.length !== 1) fail("inventory", e.path, "virtual source binding is not unique");
	return matches[0] ?? fail("inventory", e.path, "missing virtual source");
}
function coverageSchema(value: Json): FileCoverageData {
	const v = object(value, ["path", "statementMap", "fnMap", "branchMap", "s", "f", "b"]);
	function location(value: Json | undefined): Location {
		const p = object(value, ["line", "column"]);
		const line = integer(p.line);
		if (line < 1) fail("source_map", "", "line is not positive");
		return { line, column: integer(p.column) };
	}
	function range(value: Json | undefined): Range {
		const r = object(value, ["start", "end"]);
		return { start: location(r.start), end: location(r.end) };
	}
	return {
		path: pathValue(v.path),
		statementMap: Object.fromEntries(Object.entries(object(v.statementMap)).map(([id, r]) => [id, range(r)])),
		fnMap: Object.fromEntries(Object.entries(object(v.fnMap)).map(([id, item]) => {
			const f = object(item, ["name", "decl", "loc", "line"]);
			return [id, { name: text(f.name), decl: range(f.decl), loc: range(f.loc), line: integer(f.line) }];
		})),
		branchMap: Object.fromEntries(Object.entries(object(v.branchMap)).map(([id, item]) => {
			const b = object(item, ["type", "loc", "locations", "line"]);
			return [id, { type: text(b.type), loc: range(b.loc), locations: array(b.locations).map(range), line: integer(b.line) }];
		})),
		s: counter(v.s), f: counter(v.f),
		b: Object.fromEntries(Object.entries(object(v.b)).map(([id, n]) => [id, array(n).map(integer)])),
	};
}
function preparePython(e: Entry, root: string): Prepared {
	const source = e.path.includes("#") ? embeddedSource(e, root) : content(root, e.path).toString("utf8");
	if (sha256(source) !== e.sha256 || Buffer.byteLength(source) !== e.bytes)
		fail("tamper", e.path, "Python source identity differs");
	const prepared = analyzerProcess(pythonBinary(), [asset("python.py"), "prepare"], JSON.stringify({ path: e.path, source }));
	if (prepared.status !== 0 || prepared.signal)
		fail("python_analysis", e.path, prepared.stderr ?? "Python prepare failed");
	const result = object(decode(prepared.stdout));
	const coverage = coverageSchema(result.coverage ?? null);
	if (coverage.path !== e.path) fail("source_map", e.path, "Python map identity differs");
	const lines = array(result.lines).map(integer);
	unique(lines.map(String), "Python line");
	const arcs = result.arcs ?? fail("source_map", e.path, "Python arcs absent");
	return {
		entry: e, code: text(result.code), coverage, mapped: coverage,
		mapHash: sha256(JSON.stringify({ result, sourceHash: e.sha256, analyzer: sha256(readFileSync(asset("python.py"))) })),
		python: { source, lines, arcs }
	};
}
function prepare(e: Entry, root: string, embedded: Entry[]): Prepared {
	if (e.language === "python") return preparePython(e, root);
	const bytes = content(root, e.path);
	if (bytes.length !== e.bytes || sha256(bytes) !== e.sha256)
		fail("tamper", e.path, "source hash or size differs");
	const source = bytes.toString("utf8");
	syntax(source, e.path);
	if (sha256(Buffer.from(source)) !== e.sha256)
		fail("unsupported_syntax", e.path, "source is not canonical UTF-8");
	if (/\.d\.[cm]?ts$/.test(e.path)) {
		const sf = ts.createSourceFile(e.path, source, ts.ScriptTarget.Latest, true);
		const compilerOptions = { noLib: true, noResolve: true };
		const program = ts.createProgram([e.path], compilerOptions, {
			...ts.createCompilerHost(compilerOptions),
			getSourceFile: (path) => (path === e.path ? sf : undefined),
		});
		if (program.getSyntacticDiagnostics(sf).length)
			fail("unsupported_syntax", e.path, "invalid declaration syntax");
		const coverage: FileCoverageData = {
			path: e.path,
			statementMap: {},
			fnMap: {},
			branchMap: {},
			s: {},
			f: {},
			b: {},
		};
		return {
			entry: e,
			code: "",
			mapHash: sha256(JSON.stringify({ declarationSource: e.sha256, coverage })),
			coverage,
			mapped: coverage,
		};
	}
	const output = ts.transpileModule(source, {
		fileName: e.path,
		reportDiagnostics: true,
		transformers: {
			before: [(context) => (sourceFile) => {
				function visit(node: ts.Node): ts.VisitResult<ts.Node> {
					if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
						const path = `${e.path}#${node.name.text}`;
						if (embedded.some((entry) => entry.path === path)) {
							const init = node.initializer;
							if (!init || !ts.isTaggedTemplateExpression(init) || init.tag.getText(sourceFile) !== "String.raw" ||
								!ts.isNoSubstitutionTemplateLiteral(init.template) || init.template.rawText === undefined)
								fail("inventory", path, "virtual source is not a raw constant binding");
							// Bun's plugin printer escapes Unicode inside raw templates. A
							// cooked literal preserves the exact inventoried value and range.
							const literal = ts.setTextRange(ts.factory.createStringLiteral(init.template.rawText), init);
							return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, literal);
						}
					}
					return ts.visitEachChild(node, visit, context);
				}
				return ts.visitEachChild(sourceFile, visit, context);
			}]
		},
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.React,
			sourceMap: true,
			inlineSources: true,
			removeComments: true,
		},
	});
	if (
		output.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error) ||
		!output.sourceMapText
	)
		fail("unsupported_syntax", e.path, "TypeScript emission failed");
	const instrumenter: {
		instrumentSync(code: string, path: string): string;
		lastFileCoverage(): FileCoverageData;
	} = instrument.createInstrumenter({
		coverageVariable: "__d945Coverage",
		coverageGlobalScope: "globalThis",
		coverageGlobalScopeFunc: false,
		esModules: true,
		compact: false,
		preserveComments: false,
		produceSourceMap: false,
		ignoreClassMethods: [],
	});
	const code = instrumenter.instrumentSync(
		output.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ""),
		e.path,
	);
	const raw = instrumenter.lastFileCoverage();
	const coverage: FileCoverageData = {
		path: raw.path,
		statementMap: raw.statementMap,
		fnMap: raw.fnMap,
		branchMap: raw.branchMap,
		s: raw.s,
		f: raw.f,
		b: raw.b,
	};
	const mapped = mapCoverage(coverage, output.sourceMapText, source, e.path);
	return {
		entry: e,
		code,
		mapHash: sha256(JSON.stringify({ coverage, mapped, sourceMap: output.sourceMapText, code })),
		coverage,
		mapped,
	};
}

function ownershipContract(options: Options) {
	const c = object(frozen(options.contract, options.contractHash), [
		"version",
		"typescript",
		"roots",
		"projects",
		"topology",
	]);
	if (c.version !== 1 || c.typescript !== "5.9.2" || typeof c.topology !== "boolean")
		fail("schema", "", "unsupported canonical contract");
	const roots = array(c.roots).map(pathValue);
	const projects = array(c.projects).map(pathValue);
	unique(roots, "root");
	unique(projects, "project");
	if (
		!roots.length ||
		!projects.length ||
		(c.topology && [...roots].sort().join(",") !== "apps,packages,script")
	)
		fail("inventory", "", "incomplete ownership contract");
	return { version: 1, typescript: "5.9.2", roots, projects, topology: c.topology };
}

function inventoryConfigurations(value: Json | undefined, root: string, projects: string[]): void {
	const configs = array(value).map((v) => {
		const o = object(v, ["path", "sha256"]);
		return { path: pathValue(o.path), sha256: hash(o.sha256) };
	});
	unique(configs.map((c) => c.path), "configuration");
	for (const config of configs)
		if (sha256(content(root, config.path)) !== config.sha256)
			fail("tamper", config.path, "configuration drift");
	for (const project of projects)
		if (!configs.some((c) => c.path === project))
			fail("inventory", project, "project absent from inventory");
}

function inventorySources(options: Options, normalized: ReturnType<typeof ownershipContract>) {
	const inventory = object(frozen(options.inventory, options.inventoryHash), [
		"version",
		"contractHash",
		"files",
		"historical",
		"embedded",
		"configurations",
	]);
	if (inventory.version !== 1 || inventory.contractHash !== sha256(JSON.stringify(normalized)))
		fail("inventory", "", "canonical contract identity mismatch");
	const entries = array(inventory.files).map(entry);
	const historical = array(inventory.historical).map(entry);
	const embedded = array(inventory.embedded).map(entry);
	unique(
		[...entries, ...historical, ...embedded].map((e) => e.path),
		"source",
	);
	if (!entries.length) fail("inventory", "", "empty inventory");
	for (const e of [...entries, ...historical]) {
		if (entries.includes(e) && !normalized.roots.some((r) => e.path.startsWith(`${r}/`)))
			fail("inventory", e.path, "source outside contract roots");
		const bytes = content(options.root, e.path);
		if (sha256(bytes) !== e.sha256 || bytes.length !== e.bytes)
			fail("tamper", e.path, "inventory content drift");
	}
	inventoryConfigurations(inventory.configurations, options.root, normalized.projects);
	for (const e of embedded)
		if (e.language !== "python" || !entries.some((host) => e.path.startsWith(`${host.path}#`)))
			fail("inventory", e.path, "embedded source lacks an inventoried host");
	const executable = [...entries, ...embedded].filter((e) => e.language !== "sql");
	if (!executable.length || entries.some((e) => e.language === "sql" && e.category !== "migration"))
		fail("inventory", "", "nonexecutable scope is not canonical migration evidence");
	return { entries, embedded, executable };
}

function inputs(options: Options): Inputs {
	toolchain();
	if (ts.version !== "5.9.2") fail("toolchain", "", "TypeScript must be 5.9.2");
	const contract = ownershipContract(options);
	const { entries, embedded, executable } = inventorySources(options, contract);
	const files = executable.map((e) => prepare(e, options.root, embedded));
	const planValue = frozen(options.plan, options.planHash);
	const plan = commands(planValue, entries);
	const faults = faultContracts(planValue, plan, files);
	for (const file of files)
		if (
			!file.python && /import\.meta\.main/.test(readFileSync(join(options.root, file.entry.path), "utf8")) &&
			!plan.some((c) => c.kind === "cli" && c.paths[0] === file.entry.path)
		)
			fail("plan", file.entry.path, "operational CLI entry missing");
	return { options, entries: [...entries, ...embedded], files, commands: plan, roots: contract.roots, faults };
}

export function exactMetric(total: number, covered: number): Metric {
	integer(total);
	integer(covered);
	if (covered > total) fail("integer", "", "covered exceeds total");
	return { total, covered, notApplicable: total === 0 };
}
function counter(value: Json | undefined): Counts {
	const v = object(value);
	return Object.fromEntries(Object.entries(v).map(([id, n]) => [id, integer(n)]));
}
function signature(data: FileCoverageData): string {
	return JSON.stringify({
		path: data.path,
		statementMap: data.statementMap,
		fnMap: data.fnMap,
		branchMap: data.branchMap,
	});
}
function checkedCoverage(value: Json, expected: Prepared): FileCoverageData {
	const v = object(value);
	// Istanbul adds hash/_coverageSchema at runtime. Only these fixed extra keys
	// are admitted; original-map identity is always regenerated, never trusted.
	if (
		Object.keys(v).some(
			(k) =>
				![
					"path",
					"statementMap",
					"fnMap",
					"branchMap",
					"s",
					"f",
					"b",
					"hash",
					"_coverageSchema",
				].includes(k),
		)
	)
		fail("schema", expected.entry.path, "unexpected counter field");
	if (
		JSON.stringify({
			path: v.path,
			statementMap: v.statementMap,
			fnMap: v.fnMap,
			branchMap: v.branchMap,
		}) !== signature(expected.coverage)
	)
		fail("source_map", expected.entry.path, "counter source map differs from regenerated map");
	const s = counter(v.s);
	const f = counter(v.f);
	const b = Object.fromEntries(
		Object.entries(object(v.b)).map(([id, hits]) => [id, array(hits).map(integer)]),
	);
	for (const [actual, base] of [
		[s, expected.coverage.s],
		[f, expected.coverage.f],
		[b, expected.coverage.b],
	] as const) {
		if (Object.keys(actual).join(",") !== Object.keys(base).join(","))
			fail("incomplete_coverage", expected.entry.path, "counter IDs missing or unexpected");
	}
	for (const id of Object.keys(b))
		if (b[id]?.length !== expected.coverage.b[id]?.length)
			fail("incomplete_coverage", expected.entry.path, "branch arm missing");
	return { ...expected.coverage, s, f, b };
}

function verifyPythonTrace(
	trace: ObjectValue,
	receipt: ObjectValue,
	data: Inputs,
	lines: ProcessReceipt["lines"],
	coverage: ProcessReceipt["coverage"],
	loaded: string[],
): void {
	if (receipt.runtime !== "python" || trace.id !== receipt.id || trace.runtime !== "python" ||
		trace.python !== "3.12.12" || trace.coverage !== "7.10.7" || trace.flushed !== true)
		fail("incomplete_coverage", text(receipt.id), "Python normal-flush identity differs");
	const files = object(trace.files);
	const pythonFiles = data.files.filter((file) => file.python);
	if (Object.keys(files).sort().join("\0") !== pythonFiles.map((file) => file.entry.path).sort().join("\0"))
		fail("incomplete_coverage", text(receipt.id), "Python normal-flush file inventory differs");
	for (const file of pythonFiles) {
		const row = pythonTraceArcs(files[file.entry.path], file);
		const checked = analyzerProcess(pythonBinary(), [asset("python.py"), "verify-trace"], JSON.stringify({
			path: file.entry.path, source: file.python?.source, arcs: row.arcs, translatedArcs: row.translatedArcs,
			lines: lines[file.entry.path] ?? {}, branches: coverage[file.entry.path]?.b ?? {}, loaded: loaded.includes(file.entry.path),
		}));
		if (checked.status !== 0 || checked.signal || object(decode(checked.stdout)).valid !== true)
			fail("incomplete_coverage", file.entry.path, `Python normal-flush semantics differ: ${checked.stderr}`);
	}
}

function pythonTraceArcs(value: Json | undefined, file: Prepared): ObjectValue {
	const row = object(value, ["arcs", "translatedArcs"]);
	const lastLine = file.python?.source.split("\n").length ?? 0;
	for (const field of ["arcs", "translatedArcs"]) {
		const arcs = array(row[field]).map((value) => {
			const arc = array(value);
			if (arc.length !== 2 || arc.some((line) => typeof line !== "number" ||
				!Number.isSafeInteger(line) || line === 0 || Math.abs(line) > lastLine))
				fail("incomplete_coverage", file.entry.path, "invalid Python normal-flush arc");
			return JSON.stringify(arc);
		});
		unique(arcs, "Python normal-flush arc");
	}
	return row;
}

function parseReceipt(value: Json, data: Inputs): ProcessReceipt {
	const r = object(value, ["id", "parent", "pid", "exitCode", "signal", "runtime", "entry", "args", "command", "lines", "trace", "children", "loaded", "coverage"]);
	const loaded = array(r.loaded).map(pathValue);
	unique(loaded, "loaded source");
	if ([...loaded].sort().join("\0") !== Object.keys(object(r.coverage)).sort().join("\0"))
		fail("incomplete_coverage", text(r.id), "loaded source counter record missing");
	const coverage: ProcessReceipt["coverage"] = {};
	for (const [path, counters] of Object.entries(object(r.coverage))) {
		const file = data.files.find((f) => f.entry.path === path);
		if (!file) fail("identity", path, "unexpected coverage source");
		coverage[path] = checkedCoverage(counters, file);
	}
	const lines = Object.fromEntries(Object.entries(object(r.lines)).map(([path, hits]) => [path, counter(hits)]));
	const expectedLines = loaded.filter((path) => data.files.find((f) => f.entry.path === path)?.python);
	if (Object.keys(lines).sort().join("\0") !== expectedLines.sort().join("\0"))
		fail("incomplete_coverage", text(r.id), "Python line receipt missing");
	for (const path of expectedLines)
		if (Object.keys(lines[path] ?? {}).join(",") !== data.files.find((f) => f.entry.path === path)?.python?.lines.join(","))
			fail("incomplete_coverage", path, "Python executable line IDs differ");
	const exitCode = nullableExit(r.exitCode);
	const signal = nullableSignal(r.signal);
	if ((exitCode === null) === (signal === null)) fail("execution", text(r.id), "invalid native terminal outcome");
	const trace = r.trace === null ? null : object(r.trace, ["id", "runtime", "python", "coverage", "flushed", "files"]);
	if (trace) verifyPythonTrace(trace, r, data, lines, coverage, loaded);
	return {
		id: text(r.id),
		parent: text(r.parent),
		pid: integer(r.pid),
		exitCode, signal, lines, trace,
		runtime: choice(r.runtime, ["bun", "node", "python"]),
		entry: pathValue(r.entry), args: array(r.args).map(text), command: text(r.command),
		children: array(r.children).map(text),
		loaded,
		coverage,
	};
}

function summary(data: Inputs, receipts: ProcessReceipt[]) {
	const findings: Finding[] = [];
	const aggregate: Record<Dimensions, Metric> = {
		statements: exactMetric(0, 0),
		branches: exactMetric(0, 0),
		functions: exactMetric(0, 0),
		lines: exactMetric(0, 0),
	};
	const measurements = data.files.map((file) => {
		const merged = structuredClone(file.mapped);
		for (const receipt of receipts) {
			const hit = receipt.coverage[file.entry.path];
			if (!hit) continue;
			for (const id of Object.keys(merged.s))
				merged.s[id] = integer((merged.s[id] ?? 0) + (hit.s[id] ?? 0));
			for (const id of Object.keys(merged.f))
				merged.f[id] = integer((merged.f[id] ?? 0) + (hit.f[id] ?? 0));
			for (const [id, hits] of Object.entries(merged.b))
				hits.forEach((n, i) => {
					hits[i] = integer(n + (hit.b[id]?.[i] ?? 0));
				});
		}
		const lines: Counts = {};
		if (file.python) {
			for (const line of file.python.lines)
				lines[String(line)] = receipts.reduce((sum, r) => integer(sum + (r.lines[file.entry.path]?.[String(line)] ?? 0)), 0);
		} else {
			for (const [id, r] of Object.entries(merged.statementMap))
				lines[String(r.start.line)] = Math.max(lines[String(r.start.line)] ?? 0, merged.s[id] ?? 0);
		}
		const metrics: Record<Dimensions, Metric> = {
			statements: exactMetric(0, 0),
			branches: exactMetric(0, 0),
			functions: exactMetric(0, 0),
			lines: exactMetric(0, 0),
		};
		const dimensions: [Dimensions, [string, number, number][]][] = [
			[
				"statements",
				Object.entries(merged.s).map(([id, n]) => [
					id,
					n,
					merged.statementMap[id]?.start.line ?? 1,
				]),
			],
			[
				"functions",
				Object.entries(merged.f).map(([id, n]) => [id, n, merged.fnMap[id]?.loc.start.line ?? 1]),
			],
			[
				"branches",
				Object.entries(merged.b).flatMap(([id, hits]) =>
					hits.map((n, i): [string, number, number] => [
						`${id}:${i}`,
						n,
						merged.branchMap[id]?.locations[i]?.start.line ?? 1,
					]),
				),
			],
			["lines", Object.entries(lines).map(([id, n]) => [id, n, Number(id)])],
		];
		for (const [dimension, counts] of dimensions) {
			metrics[dimension] = exactMetric(counts.length, counts.filter(([, n]) => n > 0).length);
			aggregate[dimension] = exactMetric(
				aggregate[dimension].total + metrics[dimension].total,
				aggregate[dimension].covered + metrics[dimension].covered,
			);
			for (const [id, n, line] of counts)
				if (n === 0) findings.push({ class: dimension, path: file.entry.path, line, symbol: id });
		}
		return {
			path: file.entry.path,
			sha256: file.entry.sha256,
			category: file.entry.category,
			language: file.entry.language,
			mapHash: file.mapHash,
			metrics,
		};
	});
	findings.sort((a, b) =>
		`${a.class}\0${a.path}\0${a.line}\0${a.symbol}`.localeCompare(
			`${b.class}\0${b.path}\0${b.line}\0${b.symbol}`,
			"en",
		),
	);
	return { complete: true, exitCode: findings.length ? 1 : 0, aggregate, measurements, findings };
}

function approvedProcessFault(receipt: ProcessReceipt, faults: Fault[], counts: Map<string, number>): boolean {
	if (!receipt.parent || (receipt.exitCode === 0 && receipt.signal === null)) return false;
	const fault = faults.find((f) => f.command === receipt.command && f.entry === receipt.entry &&
		JSON.stringify(f.args) === JSON.stringify(receipt.args) && f.exitCode === receipt.exitCode && f.signal === receipt.signal);
	if (!fault) fail("execution", receipt.id, "unapproved native process failure");
	if ((receipt.coverage[fault.checkpoint.path]?.s[fault.checkpoint.statement] ?? 0) < fault.checkpoint.minimumHits)
		fail("incomplete_coverage", receipt.id, "approved boundary was not independently counted before termination");
	counts.set(fault.id, (counts.get(fault.id) ?? 0) + 1);
	return true;
}

function verifyProcessGraph(receipt: ProcessReceipt, receipts: ProcessReceipt[], roots: Set<string>): void {
	unique(receipt.children, "child expectation");
	if (
		!roots.has(receipt.id) &&
		!receipts.some((p) => p.id === receipt.parent && p.children.includes(receipt.id) && p.command === receipt.command)
	)
		fail("incomplete_coverage", receipt.id, "orphan process receipt");
	for (const id of receipt.children)
		if (!receipts.some((c) => c.id === id && c.parent === receipt.id))
			fail("incomplete_coverage", id, "child did not flush on actual exit");
	const seen = new Set<string>();
	let cursor: ProcessReceipt | undefined = receipt;
	while (cursor?.parent) {
		if (seen.has(cursor.id)) fail("identity", receipt.id, "process graph cycle");
		seen.add(cursor.id);
		const parent: string = cursor.parent;
		cursor = receipts.find((r) => r.id === parent);
	}
}

function verify(value: Json, data: Inputs) {
	const v = object(value, [
		"version",
		"inventoryHash",
		"contractHash",
		"planHash",
		"runtime",
		"toolchain",
		"maps",
		"commands",
		"processes",
	]);
	if (
		v.version !== 1 ||
		v.inventoryHash !== data.options.inventoryHash ||
		v.contractHash !== data.options.contractHash ||
		v.planHash !== data.options.planHash
	)
		fail("identity", "", "coverage input belongs to another frozen run");
	choice(v.runtime, ["1.3.6", "1.4.1"]);
	if (JSON.stringify(v.toolchain) !== JSON.stringify(toolchain()))
		fail("toolchain", "", "coverage analyzer identity changed");
	if (
		JSON.stringify(v.maps) !==
		JSON.stringify(data.files.map((f) => ({ path: f.entry.path, mapHash: f.mapHash })))
	)
		fail("incomplete_coverage", "", "map inventory is incomplete, reordered, stale, or tampered");
	const receipts = array(v.processes).map((r) => parseReceipt(r, data));
	unique(
		receipts.map((r) => r.id),
		"process receipt",
	);
	const observed = array(v.commands).map((item) => {
		const c = object(item, ["id", "process", "exitCode"]);
		return { id: text(c.id), process: text(c.process), exitCode: integer(c.exitCode) };
	});
	if (observed.length !== data.commands.length)
		fail("incomplete_coverage", "", "missing command receipt");
	const expectedRoots = new Set<string>();
	data.commands.forEach((command, i) => {
		const result = observed[i];
		if (!result || result.id !== command.id || result.exitCode !== command.expectedExitCode)
			fail("execution", command.id, "command exit differs from frozen expectation");
		const receipt = receipts.find((r) => r.id === result.process);
		if (
			receipt?.parent !== "" ||
			receipt.exitCode !== result.exitCode || receipt.signal !== null ||
			receipt.runtime !== (command.runtime ?? "bun") || receipt.command !== command.id ||
			!command.paths.every((p) => Object.hasOwn(receipt.coverage, p))
		)
			fail(
				"incomplete_coverage",
				command.id,
				"entry never loaded or terminal process receipt missing",
			);
		expectedRoots.add(receipt.id);
	});
	const faultCounts = new Map<string, number>();
	for (const receipt of receipts) {
		const approvedFault = approvedProcessFault(receipt, data.faults, faultCounts);
		if (receipt.runtime === "python" && receipt.trace === null && !approvedFault)
			fail("incomplete_coverage", receipt.id, "Python normal-completion trace was not flushed");
		verifyProcessGraph(receipt, receipts, expectedRoots);
	}
	for (const fault of data.faults)
		if (faultCounts.get(fault.id) !== fault.occurrences)
			fail("incomplete_coverage", fault.id, "approved fault boundary occurrence count differs");
	return {
		...summary(data, receipts),
		approvedFaults: data.faults.map((f) => ({ id: f.id, observed: faultCounts.get(f.id) ?? 0 })),
		processOutcomes: receipts.map((r) => ({ id: r.id, parent: r.parent, runtime: r.runtime, entry: r.entry, exitCode: r.exitCode, signal: r.signal })),
		runtime: v.runtime,
		authoritative: v.runtime === "1.3.6",
		toolchain: v.toolchain,
		inventoryHash: data.options.inventoryHash,
		contractHash: data.options.contractHash,
		planHash: data.options.planHash,
	};
}

function optionsFrom(value: Json): Options {
	const v = object(value, [
		"root",
		"contract",
		"contractHash",
		"inventory",
		"inventoryHash",
		"plan",
		"planHash",
	]);
	return {
		root: text(v.root),
		contract: text(v.contract),
		contractHash: hash(v.contractHash),
		inventory: text(v.inventory),
		inventoryHash: hash(v.inventoryHash),
		plan: text(v.plan),
		planHash: hash(v.planHash),
	};
}

function counterSlots(
	coverage: FileCoverageData,
): { counts: Counts | number[]; key: string; slot: number }[] {
	let slot = 0;
	return [
		...Object.keys(coverage.s).map((key) => ({ counts: coverage.s, key, slot: slot++ })),
		...Object.keys(coverage.f).map((key) => ({ counts: coverage.f, key, slot: slot++ })),
		...Object.values(coverage.b).flatMap((counts) =>
			Object.keys(counts).map((key) => ({ counts, key, slot: slot++ })),
		),
	];
}

function observe(directory: string, id: string, exitCode: number | null, signal: string | null = null): void {
	writeFileSync(join(directory, `${id}.observed.json`), JSON.stringify({ exitCode, signal }), {
		flag: "wx",
	});
}

function processCounters(directory: string, id: string, files: Prepared[]): void {
	const offsets = new Map<string, number>();
	let size = 0;
	for (const file of files) {
		offsets.set(file.entry.path, size);
		size += counterSlots(file.coverage).length + (file.python?.lines.length ?? 0);
	}
	const path = join(directory, `${id}.counts.bin`);
	writeFileSync(path, Buffer.alloc(Math.max(1, size) * 8), { flag: "wx" });
	const isBun = typeof Bun !== "undefined";
	const bytes = isBun ? Bun.mmap(path, { shared: true }) : new Uint8Array(Math.max(1, size) * 8);
	const counters = new Float64Array(bytes.buffer, bytes.byteOffset, Math.max(1, size));
	const fd = isBun ? -1 : openSync(path, "r+");
	const slotBytes = Buffer.alloc(8);
	const loaded = new Map<string, FileCoverageData>();
	const coverage: { [key: string]: FileCoverageData } = {};
	globalThis.__d945Coverage = coverage;
	for (const file of files)
		Object.defineProperty(coverage, file.entry.path, {
			enumerable: true,
			get: () => loaded.get(file.entry.path),
			set: (value: FileCoverageData) => {
				if (signature(value) !== signature(file.coverage))
					fail("source_map", file.entry.path, "instrumented code changed its map");
				for (const { counts, key, slot } of counterSlots(value)) {
					const offset = (offsets.get(file.entry.path) ?? 0) + slot;
					Object.defineProperty(counts, key, {
						enumerable: true,
						configurable: false,
						get: () => counters[offset],
						set: (n: number) => {
							counters[offset] = integer(n);
							if (!isBun) {
								slotBytes.writeDoubleLE(n);
								if (writeSync(fd, slotBytes, 0, 8, offset * 8) !== 8)
									fail("incomplete_coverage", file.entry.path, "short persistent counter write");
							}
						},
					});
				}
				loaded.set(file.entry.path, value);
				writeFileSync(join(directory, `${id}.loaded.json`), JSON.stringify([...loaded.keys()]));
			},
		});
}

function collectedProcess(directory: string, id: string, data: Inputs): Json {
	const start = object(decode(readFileSync(join(directory, `${id}.start.json`), "utf8")));
	const observed = object(decode(readFileSync(join(directory, `${id}.observed.json`), "utf8")));
	const loaded = array(decode(readFileSync(join(directory, `${id}.loaded.json`), "utf8"))).map(
		text,
	);
	unique(loaded, "loaded module");
	const counts = readFileSync(join(directory, `${id}.counts.bin`));
	let offset = 0;
	const coverage: { [key: string]: Json } = {};
	const lines: { [key: string]: Json } = {};
	for (const file of data.files) {
		const raw = structuredClone(file.coverage);
		for (const slot of counterSlots(raw)) {
			const n = integer(counts.readDoubleLE(offset));
			offset += 8;
			if (Array.isArray(slot.counts)) slot.counts[Number(slot.key)] = n;
			else slot.counts[slot.key] = n;
		}
		const lineHits: Counts = {};
		for (const line of file.python?.lines ?? []) {
			lineHits[String(line)] = integer(counts.readDoubleLE(offset)); offset += 8;
		}
		if (loaded.includes(file.entry.path)) {
			coverage[file.entry.path] = decode(JSON.stringify(raw));
			if (file.python) lines[file.entry.path] = lineHits;
		}
	}
	if (
		counts.byteLength !== Math.max(8, offset) ||
		loaded.some((path) => !data.files.some((f) => f.entry.path === path))
	)
		fail("identity", id, "counter storage or loaded-source identity differs");
	const request = object(decode(readFileSync(join(directory, `${id}.request.json`), "utf8")));
	if (start.parent !== request.parent || start.runtime !== request.runtime || start.entry !== request.entry)
		fail("identity", id, "native start differs from launch request");
	const tracePath = join(directory, `${id}.trace.json`);
	return {
		id,
		parent: text(start.parent),
		pid: integer(start.pid),
		exitCode: nullableExit(observed.exitCode), signal: nullableSignal(observed.signal),
		runtime: text(request.runtime), entry: text(request.entry), args: array(request.args), command: text(request.command), lines,
		trace: existsSync(tracePath) ? decode(readFileSync(tracePath, "utf8")) : null,
		children: decode(readFileSync(join(directory, `${id}.children.json`), "utf8")),
		loaded,
		coverage,
	};
}

// The preload is built outside the owned tree so the gate's actual CLI source
// remains instrumentable. Bun.spawn is interposed before owned code imports it.
function preload(directory: string): void {
	const data = inputs(optionsFrom(decode(readFileSync(join(directory, "options.json"), "utf8"))));
	const id = process.env.D945_PROCESS ?? fail("process", "", "missing process identity");
	const parent = process.env.D945_PARENT ?? "";
	const children: string[] = [];
	const startPath = join(directory, `${id}.start.json`);
	const request = object(decode(readFileSync(join(directory, `${id}.request.json`), "utf8")));
	const runtime = typeof Bun === "undefined" ? "node" : "bun";
	writeFileSync(startPath, JSON.stringify({ id, parent, pid: process.pid, runtime, entry: text(request.entry) }), { flag: "wx" });
	writeFileSync(join(directory, `${id}.children.json`), "[]", { flag: "wx" });
	writeFileSync(join(directory, `${id}.loaded.json`), "[]", { flag: "wx" });
	processCounters(directory, id, data.files);
	function loadedCode(absolute: string): string | undefined {
		const path = relative(data.options.root, absolute);
		const file = data.files.find((f) => f.entry.path === path);
		if (file) {
			if (sha256(content(data.options.root, path)) !== file.entry.sha256)
				fail("tamper", path, "source changed after preparation");
			return file.code;
		}
		if (data.roots.some((r) => path.startsWith(`${r}/`)) && !path.split("/").includes("node_modules"))
			fail("identity", path, "loaded source absent from frozen inventory");
		return undefined;
	}
	if (runtime === "node") {
		if (process.versions.node !== "24.19.0") fail("toolchain", "", "Node must be 24.19.0");
		nodeModules.registerHooks({
			resolve(specifier, context, next) {
				if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
					const url = new URL(specifier, context.parentURL);
					if (url.protocol === "file:") {
						const path = relative(data.options.root, fileURLToPath(url));
						const file = data.files.find((f) => [path, `${path}.ts`, `${path}.tsx`, `${path}.js`, `${path}/index.ts`].includes(f.entry.path));
						if (file) return { url: pathToFileURL(join(data.options.root, file.entry.path)).href, shortCircuit: true };
					}
				}
				return next(specifier, context);
			},
			load(url, context, next) {
				if (url.startsWith("file:")) {
					const path = fileURLToPath(url);
					const code = loadedCode(path);
					if (code !== undefined) return { source: code, format: path.endsWith(".cjs") ? "commonjs" : "module", shortCircuit: true };
				}
				return next(url, context);
			},
		});
	} else {
		if (!["1.3.6", "1.4.1"].includes(Bun.version)) fail("toolchain", "", "unsupported Bun version");
		Bun.plugin({
			name: "d945-frozen-coverage",
			setup(builder) {
				// Bun 1.3.6 cannot fall through an onLoad callback. Match only owned
				// roots (including missing owned files); dependencies keep native loaders.
				const escapePattern = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const filter = new RegExp(`^${escapePattern(data.options.root)}/(?!(?:.*/)?node_modules/)(?:${data.roots.map(escapePattern).join("|")})/.*\\.[cm]?[jt]sx?$`);
				builder.onLoad({ filter }, (args) => {
					const code = loadedCode(args.path) ?? fail("identity", args.path, "loaded source absent from frozen inventory");
					return { contents: code, loader: "js" };
				});
			},
		});
	}
	function child(command: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
		const childId = randomUUID();
		const launch = launchCommand(data, directory, childId, id, text(request.command), command, env, cwd);
		children.push(childId);
		writeFileSync(join(directory, `${id}.children.json`), JSON.stringify(children));
		return { id: childId, ...launch };
	}
	installProcessHooks(child, (childId, code, signal) => observe(directory, childId, code, signal), fail);
	if (runtime === "node") return;
	// Interposition consumes only argv/environment. Native stdio, IPC payloads,
	// callbacks and return values pass through untouched; they are not analyzer data.
	type LaunchOptions = { env?: NodeJS.ProcessEnv; cwd?: string };
	const spawn = Bun.spawn;
	const spawnSync = Bun.spawnSync;
	function bunLaunch(command: string[] | (LaunchOptions & { cmd: string[] }), options?: LaunchOptions) {
		const opts = Array.isArray(command) ? options : command;
		const argv = Array.isArray(command) ? command : command.cmd;
		if (opts?.env?.D945_PROCESS && opts.env.D945_PROCESS !== id && existsSync(join(directory, `${opts.env.D945_PROCESS}.request.json`)))
			return { argv, options: opts, id: undefined };
		const wrapped = child(argv, opts?.env, opts?.cwd);
		return { argv: wrapped.command, options: { ...opts, env: wrapped.env }, id: wrapped.id };
	}
	Object.defineProperty(Bun, "spawn", {
		value: (
			command: string[] | (LaunchOptions & { cmd: string[] }),
			options?: LaunchOptions,
		) => {
			const launch = bunLaunch(command, options);
			const result = spawn(launch.argv, launch.options);
			const childId = launch.id;
			if (childId !== undefined)
				void result.exited.then((exitCode) => observe(directory, childId, result.signalCode ? null : exitCode, signalName(result.signalCode)));
			return result;
		}
	});
	Object.defineProperty(Bun, "spawnSync", {
		value: (
			command: string[] | (LaunchOptions & { cmd: string[] }),
			options?: LaunchOptions,
		) => {
			const launch = bunLaunch(command, options);
			const result = spawnSync(launch.argv, launch.options);
			if (launch.id !== undefined)
				observe(directory, launch.id, result.signalCode ? null : result.exitCode, signalName(result.signalCode));
			return result;
		}
	});
}

function signalName(signal: string | number | null | undefined): string | null {
	if (!signal) return null;
	if (typeof signal === "string") return nullableSignal(signal);
	return Object.entries(osConstants.signals).find(([, n]) => n === signal)?.[0] ?? fail("execution", "", "unrecognized native signal");
}
function binaryPath(binary: string, env: NodeJS.ProcessEnv, cwd: string): string {
	const path = binary.includes("/") ? resolve(cwd, binary) : (env.PATH ?? "").split(":").map((p) => join(p, binary)).find(existsSync);
	return path ? resolve(path) : fail("unsupported_process", binary, "executable cannot be resolved");
}
function launchEntry(data: Inputs, argv: string[], runtime: string, executable: string, cwd: string) {
	let entry: Prepared | undefined;
	let args: string[] = [];
	if (runtime === "python" && argv.includes("-c")) {
		const index = argv.indexOf("-c");
		if (argv.slice(0, index).some((a) => a !== "-u")) fail("unsupported_process", executable, "unrecognized Python interpreter option");
		const source = argv[index + 1];
		entry = data.files.find((f) => f.python?.source === source);
		args = argv.slice(index + 2);
	} else {
		let index = 0;
		if (argv[0] === "test") index++;
		while (argv[index]?.startsWith("-")) {
			const flag = argv[index++];
			if (["--timeout", "--import", "--require", "-r", ...(runtime === "bun" ? ["--preload"] : [])].includes(flag ?? "")) index++;
			else if (!["-u", "--no-warnings", "--enable-source-maps"].includes(flag ?? ""))
				fail("unsupported_process", executable, `unregistered interpreter option ${flag}`);
		}
		const path = relative(data.options.root, resolve(cwd, argv[index] ?? ""));
		entry = data.files.find((f) => f.entry.path === path);
		args = argv.slice(index + 1);
	}
	if (!entry || (runtime === "python") !== Boolean(entry.python))
		fail("unsupported_process", executable, "entry/source is absent from frozen language inventory");
	return { entry, args };
}

function runtimeVersion(binary: string, runtime: string, executable: string): string {
	const version = analyzerProcess(binary, ["--version"]);
	const actual = version.stdout.trim();
	if (version.status !== 0 || (runtime === "bun" && !["1.3.6", "1.4.1"].includes(actual)) ||
		(runtime === "node" && actual !== "v24.19.0") || (runtime === "python" && actual !== "Python 3.12.12"))
		fail("toolchain", executable, `unsupported native runtime ${actual}`);
	return actual;
}

function launchCommand(data: Inputs, directory: string, id: string, parent: string, commandId: string,
	command: string[], environment: NodeJS.ProcessEnv, cwd: string): { command: string[]; env: NodeJS.ProcessEnv } {
	const executable = command[0] ?? fail("process", "", "empty executable");
	const binary = binaryPath(executable, environment, cwd);
	const name = basename(binary);
	const runtime = /^bun(?:\.exe)?$/.test(name) ? "bun" : /^node(?:\.exe)?$/.test(name) ? "node" : /^python(?:3(?:\.\d+)?)?$/.test(name) ? "python" :
		fail("unsupported_process", executable, "unregistered native executable");
	let argv = command.slice(1);
	if (runtime === "bun" && argv[0] === "run") argv = argv.slice(1);
	const { entry, args } = launchEntry(data, argv, runtime, executable, cwd);
	const actual = runtimeVersion(binary, runtime, executable);
	writeFileSync(join(directory, `${id}.request.json`), JSON.stringify({ parent, command: commandId, runtime, entry: entry.entry.path, args, binary, version: actual, sha256: sha256(readFileSync(binary)) }), { flag: "wx" });
	const env = {
		...environment, D945_DIRECTORY: directory, D945_PROCESS: id, D945_PARENT: parent,
		D945_ASSET_DIRECTORY: asset(""), D945_PYTHON: pythonBinary(), D945_BUN: process.env.D945_BUN ?? process.execPath
	};
	if (runtime === "python") return { command: [binary, "-u", asset("python.py"), "run", directory, id, entry.entry.path, ...args], env };
	if (runtime === "node") return { command: [binary, "--import", pathToFileURL(join(directory, "preload.mjs")).href, ...argv], env };
	return {
		command: argv[0] === "test" ? [binary, "test", "--preload", join(directory, "preload.js"), ...argv.slice(1)] :
			[binary, "--preload", join(directory, "preload.js"), ...argv], env
	};
}
async function collectCommand(data: Inputs, directory: string, command: Command): Promise<Json> {
	const id = randomUUID();
	const argv =
		command.kind === "test"
			? ["test", "--timeout", "15000", ...command.paths.map((p) => `./${p}`)]
			: [join(data.options.root, command.paths[0] ?? ""), ...command.args];
	const runtime = command.runtime ?? "bun";
	const executable = runtime === "bun" ? process.execPath : runtime === "python" ? pythonBinary() : "node";
	const launch = launchCommand(data, directory, id, "", command.id, [executable, ...argv], process.env, data.options.root);
	const child = Bun.spawn(launch.command, {
		cwd: data.options.root,
		env: launch.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
	const exitCode = await child.exited;
	clearTimeout(timeout);
	observe(directory, id, child.signalCode ? null : exitCode, signalName(child.signalCode));
	const out = await stdout;
	const err = await stderr;
	if (child.signalCode || exitCode !== command.expectedExitCode)
		fail(
			"execution",
			command.id,
			`exit ${exitCode}; stdout=${out.slice(-2000)} stderr=${err.slice(-4000)}`,
		);
	if (command.kind === "test" && !/[1-9]\d* pass/.test(err))
		fail("execution", command.id, "no successful test selection");
	return { id: command.id, process: id, exitCode };
}

async function collect(data: Inputs): Promise<Json> {
	if (!["1.3.6", "1.4.1"].includes(Bun.version)) fail("toolchain", "", "unsupported Bun version");
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "openomni-d945-coverage-")));
	try {
		writeFileSync(join(directory, "options.json"), JSON.stringify(data.options));
		const build = await Bun.build({
			entrypoints: [import.meta.path],
			outdir: directory,
			naming: "preload.js",
			target: "bun",
			packages: "external",
		});
		if (!build.success) fail("toolchain", "", "preload build failed");
		const nodeBuild = await Bun.build({ entrypoints: [import.meta.path], outdir: directory, naming: "preload.mjs", target: "node", packages: "external" });
		if (!nodeBuild.success) fail("toolchain", "", "Node preload build failed");
		let slots = 0;
		const pythonFiles = data.files.flatMap((file) => {
			const offset = slots;
			slots += counterSlots(file.coverage).length;
			const lineOffset = slots;
			slots += file.python?.lines.length ?? 0;
			return file.python ? [{ path: file.entry.path, source: file.python.source, coverage: file.coverage, lines: file.python.lines, arcs: file.python.arcs, offset, lineOffset }] : [];
		});
		writeFileSync(join(directory, "python-files.json"), JSON.stringify(pythonFiles));
		writeFileSync(join(directory, "process-size.json"), JSON.stringify({ slots: Math.max(1, slots) }));
		symlinkSync(resolve(import.meta.dir, "../node_modules"), join(directory, "node_modules"));
		const observed: Json[] = [];
		for (const command of data.commands) {
			observed.push(await collectCommand(data, directory, command));
		}
		const starts = readdirSync(directory).filter((p) => p.endsWith(".start.json"));
		const failures = readdirSync(directory).filter((p) => p.endsWith(".failure.json"));
		if (failures.length)
			fail(
				"execution",
				"",
				`process instrumentation rejected input: ${readFileSync(join(directory, failures[0] ?? ""), "utf8")}`,
			);
		for (const path of starts)
			if (!existsSync(join(directory, path.replace(".start.json", ".observed.json"))))
				fail("incomplete_coverage", path, "process termination not independently observed");
		const processes = starts
			.sort()
			.map((p) => collectedProcess(directory, p.replace(".start.json", ""), data));
		return {
			version: 1,
			inventoryHash: data.options.inventoryHash,
			contractHash: data.options.contractHash,
			planHash: data.options.planHash,
			runtime: Bun.version,
			toolchain: toolchain(),
			maps: data.files.map((f) => ({ path: f.entry.path, mapHash: f.mapHash })),
			commands: observed,
			processes,
		};
	} finally {
		// Every started child is known before cleanup; a killed child is incomplete,
		// never a clean zero. Do not leave a surviving descendant using temp input.
		for (const file of readdirSync(directory).filter((p) => p.endsWith(".start.json"))) {
			if (!existsSync(join(directory, file.replace(".start.json", ".observed.json")))) {
				const start = object(decode(readFileSync(join(directory, file), "utf8")));
				try {
					process.kill(integer(start.pid), "SIGKILL");
				} catch {
					console.error(
						JSON.stringify({ code: "cleanup_signal_unconfirmed", pid: integer(start.pid) }),
					);
				}
			}
		}
		rmSync(directory, { recursive: true, force: true });
	}
}

export function coverageForMetrics(paths: { root: string; contract: string; inventory: string; plan: string; coverage: string }) {
	const data = inputs({
		root: realpathSync(paths.root),
		contract: resolve(paths.contract), contractHash: sha256(readFileSync(paths.contract)),
		inventory: resolve(paths.inventory), inventoryHash: sha256(readFileSync(paths.inventory)),
		plan: resolve(paths.plan), planHash: sha256(readFileSync(paths.plan)),
	});
	const input = decode(readFileSync(paths.coverage, "utf8"));
	verify(input, data);
	return {
		files: data.files.map((file) => ({ path: file.entry.path, sha256: file.entry.sha256, mapped: file.mapped })),
		processes: array(object(input).processes).map((receipt) => parseReceipt(receipt, data)),
	};
}

export async function qualityCoverageMain(args = process.argv.slice(2)): Promise<number> {
	lastFailure = undefined;
	try {
		const { values } = parseArgs({
			args,
			strict: true,
			options: {
				root: { type: "string" },
				contract: { type: "string" },
				"contract-sha256": { type: "string" },
				inventory: { type: "string" },
				"inventory-sha256": { type: "string" },
				plan: { type: "string" },
				"plan-sha256": { type: "string" },
				collect: { type: "boolean" },
				"coverage-input": { type: "string" },
				"coverage-sha256": { type: "string" },
				"write-coverage": { type: "string" },
			},
		});
		const required = (value: string | undefined, name: string) =>
			value ?? fail("missing_input", name, "required frozen input absent");
		const options: Options = {
			root: realpathSync(required(values.root, "root")),
			contract: resolve(required(values.contract, "contract")),
			contractHash: required(values["contract-sha256"], "contract-sha256"),
			inventory: resolve(required(values.inventory, "inventory")),
			inventoryHash: required(values["inventory-sha256"], "inventory-sha256"),
			plan: resolve(required(values.plan, "plan")),
			planHash: required(values["plan-sha256"], "plan-sha256"),
		};
		if (
			Boolean(values.collect) === Boolean(values["coverage-input"]) ||
			(values.collect && values["coverage-sha256"]) ||
			(!values.collect && values["write-coverage"])
		)
			fail("missing_input", "", "choose collection or hash-pinned verification");
		const data = inputs(options);
		const input = values.collect
			? await collect(data)
			: frozen(
				required(values["coverage-input"], "coverage-input"),
				required(values["coverage-sha256"], "coverage-sha256"),
			);
		// Preserve authentic counter/native-outcome provenance even when verification
		// rejects an unapproved fault. Writing a receipt does not mark it complete.
		if (values["write-coverage"]) writeFileSync(values["write-coverage"], JSON.stringify(input));
		const result = verify(input, data);
		console.log(JSON.stringify(result));
		return result.exitCode;
	} catch {
		const record = lastFailure ?? {
			code: "analysis_error",
			path: "",
			message: "native analyzer or filesystem failure",
		};
		console.log(JSON.stringify({ complete: false, exitCode: 2, errors: [record] }));
		return 2;
	}
}

if (
	process.env.D945_DIRECTORY &&
	["preload.js", "preload.mjs"].some((name) => fileURLToPath(import.meta.url) === join(process.env.D945_DIRECTORY ?? "", name))
) {
	preload(process.env.D945_DIRECTORY);
} else if (import.meta.main) process.exitCode = await qualityCoverageMain();
