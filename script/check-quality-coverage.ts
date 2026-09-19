/** Strict, inventory-consuming coverage path for the existing coverage owner.
 * No source discovery, percentages, exclusions, baseline or update operation.
 * Collection and verification regenerate the same pinned executable maps.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	openSync,
	writeSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, constants as osConstants } from "node:os";
import nativeProcesses from "node:child_process";
import * as nodeModules from "node:module";
import * as workerThreads from "node:worker_threads";
import { installProcessHooks } from "./quality-coverage/node";
import { installWorkerHooks, workerExecArgv } from "./quality-coverage/worker";
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	unmapped?: UnmappedCounter[];
	transfer?: EmittedTransfer;
	python?: { source: string; lines: number[]; arcs: Json };
};
type UnmappedCounter = {
	kind: "statement" | "function" | "branch";
	id: string;
	start: Location;
	end: Location;
};
type EmittedTransfer = {
	signature: string;
	slots: Record<string, string | null>;
};
type EmissionObservation = {
	path: string; phase: "before" | "after"; kind: number; pos: number; end: number;
	originalKind: number; originalPos: number; originalEnd: number; offset: number;
};
type EmissionHooks = {
	onNode: (path: string, phase: "before" | "after", offset: number, node: ts.Node) => void;
	onToken: (path: string, phase: "before" | "after", offset: number, node: ts.Node) => void;
};
type EmissionProof = {
	path: string; source: string; project: string; sha256: string; mapSha256: string;
	mapHash: string; observationSha256: string; observationCount: number; syntheticCount: number;
};
type Command = {
	id: string;
	kind: string;
	paths: string[];
	args: string[];
	expectedExitCode: number;
	runtime?: string;
	cwd?: string;
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
	selected: boolean;
	projects: string[];
	configurations: { path: string; sha256: string }[];
};
// The instrumented processes only consume the prepared inventory; commands stay
// with the collector.
type PreloadInputs = Pick<Inputs, "options" | "entries" | "files" | "roots" | "selected" | "projects" | "configurations">;
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
	cwd?: string;
	lines: { [key: string]: Counts };
	trace: ObjectValue | null;
	children: string[];
	loaded: string[];
	coverage: { [key: string]: FileCoverageData };
	// JavaScript processes only: the loaded sources that arrived through a
	// compiled module, each bound to one emission proof.
	transferred?: string[];
	emitted?: EmissionProof[];
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
// Only the instrumented process itself files a failure with its collector. A checker CLI
// launched under a collection (a test fixture exercising the gate) reports through its own
// result and must not leave an inherited process identity's failure in the outer directory.
let instrumented = false;
function fail(code: string, path: string, message: string): never {
	lastFailure = new CoverageError(code, path, message);
	if (instrumented && process.env.D945_DIRECTORY && process.env.D945_PROCESS)
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
// Sticky scanners keep the pass linear: instrumented children decode the whole
// prepared inventory at startup, so per-character work is process latency.
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON forbids raw U+0000..U+001F inside strings, so a plain run must stop there
const PLAIN_RUN = /[^"\\\u0000-\u001f]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
export function decode(text: string): Json {
	let i = 0;
	const ws = () => {
		for (let c = text.charCodeAt(i); c === 32 || c === 10 || c === 13 || c === 9; c = text.charCodeAt(i)) i++;
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
		// Runs of plain characters are copied as one slice; only escapes and
		// control characters are examined individually.
		let result = "";
		while (i < text.length) {
			PLAIN_RUN.lastIndex = i;
			PLAIN_RUN.test(text);
			result += text.slice(i, PLAIN_RUN.lastIndex);
			i = PLAIN_RUN.lastIndex;
			const c = text[i++];
			if (c === '"') return result;
			if (c !== "\\") fail("schema", "", c === undefined ? "unterminated string" : "invalid string");
			result += escapedCharacter();
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
		if (c === "t" && text.startsWith("true", i)) { i += 4; return true; }
		if (c === "f" && text.startsWith("false", i)) { i += 5; return false; }
		if (c === "n" && text.startsWith("null", i)) { i += 4; return null; }
		NUMBER.lastIndex = i;
		const number = NUMBER.exec(text);
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

function commandDirectory(value: Json | undefined, root: string): string {
	const cwd = value === "." ? "." : pathValue(value);
	const absolute = resolve(root, cwd);
	if (!existsSync(absolute) || realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory())
		fail("path", cwd, "command cwd must be a canonical repository directory");
	return cwd;
}
function commands(value: Json, entries: Entry[], root: string): Command[] {
	const plan = object(value);
	object(value, ["version", "commands", ...(plan.version === 3 || plan.run !== undefined ? ["run"] : [])]);
	if (![1, 2, 3].includes(integer(plan.version))) fail("schema", "", "unsupported plan version");
	if (plan.run !== undefined) {
		const run = object(plan.run, ["id", "selectionHash"]);
		if (!text(run.id)) fail("identity", "", "empty coverage run");
		hash(run.selectionHash);
	}
	const result = array(plan.commands).map((item) => {
		const v = object(item);
		object(item, ["id", "kind", "paths", "args", "expectedExitCode", ...(v.runtime === undefined ? [] : ["runtime"]), ...(plan.version === 3 ? ["cwd"] : [])]);
		const command = {
			id: text(v.id),
			kind: choice(v.kind, ["test", "cli"]),
			paths: array(v.paths).map(pathValue),
			args: array(v.args).map(text),
			expectedExitCode: integer(v.expectedExitCode),
			runtime: v.runtime === undefined ? "bun" : choice(v.runtime, ["bun", "node", "python"]),
			...(plan.version === 3 ? { cwd: commandDirectory(v.cwd, root) } : {}),
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
		(e) => plan.version !== 3 && e.category === "test" && /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.path),
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
function importMetaUrl(value: ts.Node | undefined): boolean {
	return value !== undefined && ts.isPropertyAccessExpression(value) && value.name.text === "url" &&
		ts.isMetaProperty(value.expression) && value.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
		value.expression.name.text === "meta";
}
function frozenWorkerTarget(node: ts.NewExpression, sf: ts.SourceFile): boolean {
	const argument = node.arguments?.[0];
	if (!node.arguments || ![1, 2].includes(node.arguments.length) || !argument ||
		!ts.isNewExpression(argument) || argument.expression.getText(sf) !== "URL")
		return false;
	const args = argument.arguments ?? [];
	return args.length === 1 ? importMetaUrl(args[0]) :
		args.length === 2 && args[0] !== undefined && ts.isStringLiteral(args[0]) && importMetaUrl(args[1]);
}
// eval, Function and require evaluate source or load modules the collector
// never prepared unless their argument is a literal; eval and Function never
// load a frozen file even then.
function dynamicCode(node: ts.CallExpression, sf: ts.SourceFile, path: string): void {
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
// A string literal naming a module: the source of an import or export
// declaration, or the argument of import() or require().
function moduleSpecifier(node: ts.Node, sf: ts.SourceFile): node is ts.StringLiteral {
	if (!ts.isStringLiteral(node)) return false;
	if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return true;
	return ts.isCallExpression(node.parent) &&
		(node.parent.expression.kind === ts.SyntaxKind.ImportKeyword || node.parent.expression.getText(sf) === "require");
}
export function syntax(source: string, path: string): void {
	const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) dynamicCode(node, sf, path);
		if (ts.isNewExpression(node) && node.expression.getText(sf) === "Function")
			fail("unsupported_syntax", path, "dynamic executable source");
		if (ts.isNewExpression(node) && node.expression.getText(sf) === "Worker" && !frozenWorkerTarget(node, sf))
			fail("unsupported_process", path, "worker target is not a frozen file URL");
		if (moduleSpecifier(node, sf) && /^(node:)?(cluster|vm)$/.test(node.text))
			fail("unsupported_process", path, "Node process/context hooks are not supported by the Bun collector");
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
	allowUnmapped = false,
	unmapped: UnmappedCounter[] = [],
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
	const traceMap = new sourceMapping.TraceMap(sourceMap);
	function position(location: Location): Location | undefined {
		if (!Number.isInteger(location.line) || !Number.isInteger(location.column))
			return allowUnmapped ? undefined : fail("source_map", path, "missing executable position");
		const p = sourceMapping.originalPositionFor(traceMap, location);
		if (
			p.source !== basename(path) ||
			p.line === null ||
			p.column === null ||
			p.line < 1 ||
			p.line > lines.length ||
			p.column > (lines[p.line - 1]?.length ?? 0)
		)
			return allowUnmapped ? undefined : fail("source_map", path, "unmapped executable position");
		return { line: p.line, column: p.column };
	}
	function range(r: Range): Range | undefined {
		const start = position(r.start);
		const end = position(r.end);
		if (!start || !end) return undefined;
		if (start.line > end.line || (start.line === end.line && start.column > end.column))
			fail("source_map", path, "reversed original range");
		return { start, end };
	}
	const statementMap = Object.fromEntries(
		Object.entries(raw.statementMap).flatMap(([id, r]) => {
			const mapped = range(r);
			if (!mapped) unmapped.push({ kind: "statement", id, start: r.start, end: r.end });
			return mapped ? [[id, mapped]] : [];
		}),
	);
	const fnMap = Object.fromEntries(
		Object.entries(raw.fnMap).flatMap(([id, f]) => {
			const decl = range(f.decl);
			const loc = range(f.loc);
			if (!decl || !loc) {
				unmapped.push({ kind: "function", id, start: f.loc.start, end: f.loc.end });
				return [];
			}
			return [[id, { name: f.name, decl, loc, line: loc.start.line }]];
		}),
	);
	const branchMap = Object.fromEntries(
		Object.entries(raw.branchMap).flatMap(([id, b]) => {
			const loc = range(b.loc);
			const locations = b.locations.flatMap((r, index) => {
				const mapped = range(
					b.type === "if" &&
						index === 1 &&
						r.start.line === undefined &&
						r.start.column === undefined &&
						r.end.line === undefined &&
						r.end.column === undefined
						? b.loc
						: r,
				);
				return mapped ? [mapped] : [];
			});
			if (!loc || locations.length !== b.locations.length) {
				unmapped.push({ kind: "branch", id, start: b.loc.start, end: b.loc.end });
				return [];
			}
			return [[id, { type: b.type, loc, locations, line: loc.start.line }]];
		}),
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
// Istanbul records the implicit else of an `if` as an empty location. The raw
// map keeps it, and istanbul's key order, so the runtime signature stays
// byte-identical; mapped coverage admits neither.
const implicitLocation: Location = Object.freeze({}) as Location;
function location(value: Json | undefined, raw = false): Location {
	const p = object(value);
	if (raw && Object.keys(p).length === 0) return implicitLocation;
	object(p, ["line", "column"]);
	const line = integer(p.line);
	if (line < 1) fail("source_map", "", "line is not positive");
	return { line, column: integer(p.column) };
}
function range(value: Json | undefined, raw = false): Range {
	const r = object(value, ["start", "end"]);
	return { start: location(r.start, raw), end: location(r.end, raw) };
}
function coverageSchema(value: Json, raw = false): FileCoverageData {
	const v = object(value, ["path", "statementMap", "fnMap", "branchMap", "s", "f", "b"]);
	return {
		path: pathValue(v.path),
		statementMap: Object.fromEntries(Object.entries(object(v.statementMap)).map(([id, r]) => [id, range(r, raw)])),
		fnMap: Object.fromEntries(Object.entries(object(v.fnMap)).map(([id, item]) => {
			const f = object(item, ["name", "decl", "loc", "line"]);
			return [id, { name: text(f.name), decl: range(f.decl, raw), loc: range(f.loc, raw), line: integer(f.line) }];
		})),
		branchMap: Object.fromEntries(Object.entries(object(v.branchMap)).map(([id, item]) => {
			const b = object(item, ["type", "loc", "locations", "line"]);
			const type = text(b.type);
			const loc = range(b.loc, raw);
			const locations = array(b.locations).map((item) => range(item, raw));
			const line = integer(b.line);
			return [id, raw ? { loc, type, locations, line } : { type, loc, locations, line }];
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
			// The repository's JSX is the automatic runtime (tsconfig "react-jsx"): no file
			// imports React, so classic emission would reference an undefined binding.
			jsx: ts.JsxEmit.ReactJSX,
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
	return instrumentOutput(e, source, output.outputText, output.sourceMapText);
}

function instrumentOutput(
	e: Entry,
	source: string,
	javascript: string,
	sourceMap: string,
	allowUnmapped = false,
): Prepared {
	const instrumenter: {
		instrumentSync(code: string, path: string): string;
		lastFileCoverage(): FileCoverageData & {
			readonly hash?: string;
			readonly _coverageSchema?: string;
		};
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
	let code = instrumenter.instrumentSync(
		javascript.replace(/^\/\/# sourceMappingURL=.*$/m, ""),
		e.path,
	);
	const raw = instrumenter.lastFileCoverage();
	let coverageHash = raw.hash ?? /^\s*var hash = "([0-9a-f]{40})";$/m.exec(code)?.[1];
	if (allowUnmapped) {
		// Istanbul guards `coverage[path] = coverageData` with `coverage[path].hash
		// !== hash`, and that hash covers only the path and maps. An emission whose
		// maps equal the original's would reuse an already loaded original instance
		// and never reach the counter setter that records its transfer, so every
		// emission carries a hash the original can never produce.
		if (!coverageHash || code.split(`"${coverageHash}"`).length !== 3)
			return fail("emitted_source", e.path, "Istanbul coverage hash literal is missing");
		const distinct = sha256(`emission\0${coverageHash}`).slice(0, coverageHash.length);
		code = code.replaceAll(`"${coverageHash}"`, `"${distinct}"`);
		coverageHash = distinct;
	}
	let injectedId: string | undefined;
	let coverageFunction: string | undefined;
	if (allowUnmapped && e.path === "packages/protocol/src/error/index.ts") {
		// This transfer is a proof for one inspected lowering, not a general
		// class-field heuristic. A new source or emit needs a new proof.
		if (sha256(source) !== "c03959dee663c141cf5c5aad8717d0d5d6e3d39f821bd7b102fed89ad2dd0eac" ||
			sha256(javascript) !== "651f266300f7177f597ba6e245b67ff6cde55479c660e90fe2b4182b08d1602a")
			fail("source_map", e.path, "NamedError transfer identity differs");
		const target = /\b[A-Za-z_$][\w$]*\.Schema\s*=\s*schema\b/.exec(code);
		const originalTarget = /\b[A-Za-z_$][\w$]*\.Schema\s*=\s*schema\b/.exec(javascript);
		coverageFunction = /function (cov_[A-Za-z0-9_$]+)\(\)/.exec(code)?.[1];
		if (!target || !originalTarget || !coverageFunction)
			fail("emitted_source", e.path, "NamedError Schema probe anchor is missing");
		const id = String(Math.max(-1, ...Object.keys(raw.s).map(Number)) + 1);
		injectedId = id;
		code = `${code.slice(0, target.index)}${coverageFunction}().s[${id}]++, ${code.slice(target.index)}`;
		const before = javascript.slice(0, originalTarget.index);
		const line = before.split(/\r?\n/).length;
		const column = before.length - (before.lastIndexOf("\n") + 1);
		raw.s[id] = 0;
		raw.statementMap[id] = {
			start: { line, column },
			end: { line, column: column + originalTarget[0].length },
		};
	}
	if (coverageFunction && injectedId !== undefined) {
		const runtimeCoverage = JSON.stringify({
			path: raw.path,
			statementMap: raw.statementMap,
			fnMap: raw.fnMap,
			branchMap: raw.branchMap,
			s: raw.s,
			f: raw.f,
			b: raw.b,
			hash: coverageHash,
			_coverageSchema: raw._coverageSchema,
		});
		const sourceFile = ts.createSourceFile("instrumented.js", code, ts.ScriptTarget.Latest, true);
		let initializer: ts.Expression | undefined;
		function find(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "coverageData") {
				if (initializer) fail("source_map", e.path, "multiple Istanbul coverageData initializers");
				initializer = node.initializer;
			}
			ts.forEachChild(node, find);
		}
		find(sourceFile);
		if (!initializer) fail("source_map", e.path, "missing Istanbul coverageData initializer");
		const start = initializer.getStart(sourceFile);
		code = `${code.slice(0, start)}${runtimeCoverage}${code.slice(initializer.end)}`;
	}
	const coverage: FileCoverageData = {
		path: raw.path,
		statementMap: raw.statementMap,
		fnMap: raw.fnMap,
		branchMap: raw.branchMap,
		s: raw.s,
		f: raw.f,
		b: raw.b,
	};
	const unmapped: UnmappedCounter[] = [];
	const mapped = mapCoverage(coverage, sourceMap, source, e.path, allowUnmapped, unmapped);
	if (injectedId !== undefined)
		unmapped.splice(0, unmapped.length, ...unmapped.filter((counter) => counter.id !== injectedId));
	return {
		entry: e,
		code,
		mapHash: sha256(JSON.stringify({ coverage, mapped, sourceMap, code })),
		coverage,
		mapped,
		...(unmapped.length ? { unmapped } : {}),
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

function inventoryConfigurations(value: Json | undefined, root: string, projects: string[]) {
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
	return configs;
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
	const configurations = inventoryConfigurations(inventory.configurations, options.root, normalized.projects);
	for (const e of embedded)
		if (e.language !== "python" || !entries.some((host) => e.path.startsWith(`${host.path}#`)))
			fail("inventory", e.path, "embedded source lacks an inventoried host");
	const executable = [...entries, ...embedded].filter((e) => e.language !== "sql");
	if (!executable.length || entries.some((e) => e.language === "sql" && e.category !== "migration"))
		fail("inventory", "", "nonexecutable scope is not canonical migration evidence");
	return { entries, embedded, executable, configurations };
}

function inputs(options: Options): Inputs {
	toolchain();
	if (ts.version !== "5.9.2") fail("toolchain", "", "TypeScript must be 5.9.2");
	const contract = ownershipContract(options);
	const { entries, embedded, executable, configurations } = inventorySources(options, contract);
	const files = executable.map((e, index) => {
		if (import.meta.main && index % 100 === 0)
			console.error(`[coverage-prepare] ${index}/${executable.length} ${e.path}`);
		return prepare(e, options.root, embedded);
	});
	const planValue = frozen(options.plan, options.planHash);
	const plan = commands(planValue, entries, options.root);
	const selected = object(planValue).version === 3;
	for (const file of files)
		if (
			!selected && !file.python && /import\.meta\.main/.test(readFileSync(join(options.root, file.entry.path), "utf8")) &&
			!plan.some((c) => c.kind === "cli" && c.paths[0] === file.entry.path)
		)
			fail("plan", file.entry.path, "operational CLI entry missing");
	return { options, entries: [...entries, ...embedded], files, commands: plan, roots: contract.roots, selected, projects: contract.projects, configurations };
}
// The collector prepares the inventory once and every instrumented process reads
// the same snapshot: re-instrumenting the repository per spawned child made one
// workspace suite exceed hosted-runner deadlines. Loaded sources are still hashed
// against the frozen entries at load time.
export function preparedFrom(value: Json): Prepared {
	const v = object(value);
	const transfer = v.transfer === undefined ? undefined : object(v.transfer, ["signature", "slots"]);
	const python = v.python === undefined ? undefined : object(v.python, ["source", "lines", "arcs"]);
	return {
		entry: entry(object(v.entry)),
		code: text(v.code),
		mapHash: hash(v.mapHash),
		coverage: coverageSchema(object(v.coverage), python === undefined),
		mapped: coverageSchema(object(v.mapped)),
		...(v.unmapped === undefined ? {} : {
			unmapped: array(v.unmapped).map((item) => {
				const u = object(item, ["kind", "id", "start", "end"]);
				const kind = text(u.kind);
				if (kind !== "statement" && kind !== "function" && kind !== "branch") return fail("schema", "", "invalid enum");
				return { kind, id: text(u.id), start: location(u.start), end: location(u.end) };
			}),
		}),
		...(transfer ? {
			transfer: {
				signature: text(transfer.signature),
				slots: Object.fromEntries(Object.entries(object(transfer.slots)).map(([label, slot]) => [label, slot === null ? null : text(slot)])),
			},
		} : {}),
		...(python ? { python: { source: text(python.source), lines: array(python.lines).map(integer), arcs: python.arcs ?? null } } : {}),
	};
}
function preloadInputsFrom(value: Json): PreloadInputs {
	const v = object(value, ["options", "entries", "files", "roots", "selected", "projects", "configurations"]);
	if (typeof v.selected !== "boolean") fail("schema", "", "expected boolean");
	return {
		options: optionsFrom(object(v.options)),
		entries: array(v.entries).map(entry),
		files: array(v.files).map(preparedFrom),
		roots: array(v.roots).map(text),
		selected: v.selected === true,
		projects: array(v.projects).map(text),
		configurations: array(v.configurations).map((item) => {
			const c = object(item, ["path", "sha256"]);
			return { path: pathValue(c.path), sha256: hash(c.sha256) };
		}),
	};
}
function preloadInputs(data: Inputs): PreloadInputs {
	const { options, entries, files, roots, selected, projects, configurations } = data;
	return { options, entries, files, roots, selected, projects, configurations };
}
// Only the declared compiler can prove a generated module. Programs are lazy:
// unrelated build outputs never enter ownership or change its denominator.
const emitPrograms = new WeakMap<PreloadInputs, Map<string, {
	program: ts.Program;
	identity: string;
	capture<T>(rows: EmissionObservation[], action: () => T): T;
}>>();
function emittedProgram(data: PreloadInputs, project: string, parsed: ts.ParsedCommandLine) {
	let programs = emitPrograms.get(data);
	if (!programs) { programs = new Map(); emitPrograms.set(data, programs); }
	const cached = programs.get(project);
	if (cached) return cached;
	let observations: EmissionObservation[] | undefined;
	const hooks: EmissionHooks = {
		onNode: (path, phase, offset, node) => {
			const original = ts.getOriginalNode(node);
			observations?.push({ path: relative(data.options.root, path), phase, kind: node.kind, pos: node.pos, end: node.end,
				originalKind: original.kind, originalPos: original.pos, originalEnd: original.end, offset });
		},
		onToken: (path, phase, offset, node) => {
			const original = ts.getOriginalNode(node);
			observations?.push({ path: relative(data.options.root, path), phase, kind: node.kind, pos: node.pos, end: node.end,
				originalKind: original.kind, originalPos: original.pos, originalEnd: original.end, offset });
		},
	};
	const host = Object.assign(ts.createCompilerHost(parsed.options), {
		getEmitObserver: () => hooks,
	});
	const program = ts.createProgram(parsed.fileNames, parsed.options, host);
	const sources = program.getSourceFiles().map((source) => {
		const path = relative(data.options.root, source.fileName);
		const entry = data.entries.find((entry) => entry.path === path);
		if (entry) {
			if (sha256(source.text) !== entry.sha256) fail("tamper", path, "compiler source differs from inventory");
		} else if (!source.isDeclarationFile || !source.fileName.split("/").includes("node_modules"))
			fail("emitted_source", path, "compiler input is not inventoried source or dependency declaration");
		return { path, sha256: sha256(source.text) };
	});
	const result = {
		program, identity: sha256(JSON.stringify({ project, options: parsed.options, configurations: data.configurations, sources })),
		capture<T>(rows: EmissionObservation[], action: () => T): T {
			observations = rows;
			try { return action(); } finally { observations = undefined; }
		},
	};
	programs.set(project, result);
	return result;
}
// Receipt verification proves each emitted module once per frozen input: the
// proof depends only on frozen bytes, so every process that reports the same
// dist file compares against one compiler emission instead of repeating it.
const receiptEmissions = new WeakMap<PreloadInputs, Map<string, EmissionProof>>();
function receiptEmission(data: PreloadInputs, path: string): EmissionProof {
	let proofs = receiptEmissions.get(data);
	if (!proofs) { proofs = new Map(); receiptEmissions.set(data, proofs); }
	const cached = proofs.get(path);
	if (cached) return cached;
	const { proof } = verifiedEmission(data, path);
	proofs.set(path, proof);
	return proof;
}
function emittedSource(data: PreloadInputs, path: string) {
	pathValue(path);
	if (!/\.[cm]?js$/.test(path) || !existsSync(join(data.options.root, `${path}.map`)))
		return fail("identity", path, "loaded source absent from frozen inventory and verified compiler output");
	const javascriptBytes = content(data.options.root, path);
	const mapBytes = content(data.options.root, `${path}.map`);
	const javascript = javascriptBytes.toString("utf8");
	const sourceMap = mapBytes.toString("utf8");
	if (!javascriptBytes.equals(Buffer.from(javascript)) || !mapBytes.equals(Buffer.from(sourceMap)))
		fail("tamper", path, "compiler output is not canonical UTF-8");
	const map = object(decode(sourceMap));
	if (map.version !== 3 || map.file !== basename(path) || map.sourceRoot !== "" || array(map.sources).length !== 1)
		fail("source_map", path, "unsupported emitted source map identity");
	const sourcePath = pathValue(relative(data.options.root, resolve(data.options.root, dirname(path), text(array(map.sources)[0]))));
	const original = data.files.find((file) => file.entry.path === sourcePath);
	if (!original || original.python) return fail("source_map", path, "emitted source is absent from frozen inventory");
	const source = content(data.options.root, sourcePath).toString("utf8");
	if (sha256(source) !== original.entry.sha256) fail("tamper", sourcePath, "emitted original source changed");
	if (map.sourcesContent !== undefined && (array(map.sourcesContent).length !== 1 || array(map.sourcesContent)[0] !== source))
		fail("source_map", path, "emitted source content differs");
	return { javascript, sourceMap, map, sourcePath, original, source };
}
function emissionProject(data: PreloadInputs, project: string, sourcePath: string, path: string): ts.ParsedCommandLine | undefined {
	const parsed = ts.getParsedCommandLineOfConfigFile(join(data.options.root, project), {}, {
		...ts.sys,
		readFile: (absolute) => {
			const path = relative(data.options.root, absolute);
			const config = data.configurations.find((config) => config.path === path);
			if (!config || sha256(content(data.options.root, path)) !== config.sha256)
				return fail("emitted_config", path, "compiler configuration is not frozen");
			return content(data.options.root, path).toString("utf8");
		},
		onUnRecoverableConfigFileDiagnostic: () => fail("emitted_config", project, "invalid compiler configuration"),
	});
	if (!parsed || parsed.errors.length) fail("emitted_config", project, "invalid compiler configuration");
	if (parsed.options.noEmit || !parsed.options.outDir || !parsed.fileNames.includes(join(data.options.root, sourcePath))) return undefined;
	if (!ts.getOutputFileNames(parsed, join(data.options.root, sourcePath), false).includes(join(data.options.root, path))) return undefined;
	if (!parsed.options.sourceMap || parsed.options.inlineSourceMap || parsed.options.outFile || parsed.options.emitDeclarationOnly || parsed.projectReferences?.length || parsed.options.module !== ts.ModuleKind.ESNext)
		fail("emitted_config", project, "only external-map per-source ES module emission is supported");
	return parsed;
}
function verifiedEmission(data: PreloadInputs, path: string): { file: Prepared; proof: EmissionProof } {
	const { javascript, sourceMap, map, sourcePath, original, source } = emittedSource(data, path);
	for (const project of data.projects.filter((project) => sourcePath.startsWith(`${dirname(project)}/`)).sort()) {
		const parsed = emissionProject(data, project, sourcePath, path);
		if (!parsed) continue;
		const compiler = emittedProgram(data, project, parsed);
		const input = compiler.program.getSourceFile(join(data.options.root, sourcePath)) ?? fail("emitted_source", sourcePath, "compiler original is missing");
		const outputs = new Map<string, string>();
		const observations: EmissionObservation[] = [];
		const emitted = compiler.capture(observations, () => compiler.program.emit(input, (absolute, text) => {
			outputs.set(relative(data.options.root, absolute), text);
		}));
		if (emitted.emitSkipped || emitted.diagnostics.length || compiler.program.getSyntacticDiagnostics(input).length)
			fail("emitted_source", sourcePath, "declared compiler emission failed");
		if (outputs.get(path) !== javascript || outputs.get(`${path}.map`) !== sourceMap)
			fail("tamper", path, "JavaScript or source map differs from declared compiler emission");
		// Map normalization occurs only after byte-for-byte compiler proof. The
		// original owner still requires a complete, ordered statement/function/
		// branch bijection; helper-producing lowering is not guessed or dropped.
		const normalizedMap = JSON.stringify({ ...map, sources: [basename(sourcePath)], sourcesContent: [source] });
		const file = instrumentOutput(original.entry, source, javascript, normalizedMap, true);
		const transfer = sourcePath === "packages/protocol/src/error/index.ts"
			? namedErrorTransfer(original.mapped, file, path, source, javascript, observations.filter((row) => row.path === path))
			: (() => {
				if (signature(file.mapped) !== signature(original.mapped))
					fail("source_map", path, "emitted executable map differs from original owner; unsupported lowering");
				return identityTransfer(original.coverage, file);
			})();
		file.transfer = transfer;
		const javascriptObservations = observations.filter((row) => row.path === path);
		if (!javascriptObservations.length || javascriptObservations.some((row) => row.offset < 0))
			fail("emitted_source", path, "emitter observation lacks final JavaScript offsets");
		return { file, proof: {
			path, source: sourcePath, project, sha256: sha256(javascript), mapSha256: sha256(sourceMap),
			mapHash: sha256(JSON.stringify({
				compiler: compiler.identity,
				map: file.mapHash,
				original: original.mapHash,
				transfer: file.transfer,
			})),
			observationSha256: sha256(JSON.stringify(javascriptObservations)),
			observationCount: javascriptObservations.length,
			syntheticCount: javascriptObservations.filter((row) => row.pos < 0).length,
		} };
	}
	return fail("emitted_config", path, "no declared compiler project produces this path");
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
function identityTransfer(original: FileCoverageData, emitted: Prepared): EmittedTransfer {
	return {
		signature: signature(emitted.coverage),
		slots: Object.fromEntries(counterSlots(original).map(({ label }) => [label, label])),
	};
}
function namedErrorTransfer(
	original: FileCoverageData,
	emitted: Prepared,
	path: string,
	source: string,
	javascript: string,
	observations: EmissionObservation[],
): EmittedTransfer {
	if (
		Object.keys(original.s).length !== 24 ||
		Object.keys(original.f).length !== 6 ||
		Object.keys(original.b).length !== 6 ||
		Object.keys(emitted.coverage.s).length !== 28 ||
		Object.keys(emitted.coverage.f).length !== 7 ||
		Object.keys(emitted.coverage.b).length !== 10
	)
		fail("source_map", path, "NamedError counter cardinality differs from pinned transfer");
	const unmapped = (emitted.unmapped ?? []).map((counter) => `${counter.kind}:${counter.id}`).sort();
	if (JSON.stringify(unmapped) !== JSON.stringify([
		"branch:0", "branch:1", "branch:2", "branch:3",
		"function:0", "statement:0", "statement:1", "statement:2", "statement:3",
		"statement:8",
	]))
		fail("source_map", path, `NamedError helper partition differs from pinned transfer: ${JSON.stringify(unmapped)}`);
	const statements = [
		[0, 4], [1, 5], [2, 6], [3, 7], [4, 8], [5, 27], [6, 12],
		[7, 9], [8, 10], [9, 11], [10, 13], [11, 14], [12, 15], [13, 16],
		[14, 17], [15, 18], [16, 19], [17, 20], [18, 21], [19, 22], [20, 23],
		[21, 24], [22, 25], [23, 26],
	].map(([canonical, emittedId]) => [`s:${emittedId}`, `s:${canonical}`]);
	const functions = Object.keys(original.f).map((id) => [`f:${Number(id) + 1}`, `f:${id}`]);
	const branches = Object.entries(original.b).flatMap(([id, counts]) => {
		const lowered = emitted.coverage.branchMap[String(Number(id) + 4)];
		if (!lowered || lowered.type !== original.branchMap[id]?.type || lowered.locations.length !== counts.length)
			fail("source_map", path, `NamedError branch shape differs: ${id}`);
		return counts.map((_, index) => [`b:${Number(id) + 4}:${index}`, `b:${id}:${index}`]);
	});
	const slots: EmittedTransfer["slots"] = Object.fromEntries([...statements, ...functions, ...branches]);
	for (const { label } of counterSlots(emitted.coverage)) {
		if (/^(s:[0-3]|f:0|b:[0-3]:\d+)$/.test(label)) {
			if (Object.hasOwn(slots, label)) fail("source_map", path, "NamedError helper counter received source ownership");
			slots[label] = null;
		}
	}
	const emittedLabels = counterSlots(emitted.coverage).map(({ label }) => label).sort();
	const canonicalLabels = counterSlots(original).map(({ label }) => label).sort();
	if (JSON.stringify(Object.keys(slots).sort()) !== JSON.stringify(emittedLabels) ||
		JSON.stringify(Object.values(slots).filter((label) => label !== null).sort()) !== JSON.stringify(canonicalLabels))
		fail("source_map", path, "NamedError transfer is not a complete counter bijection");
	const canonicalSchema = original.statementMap["5"];
	if (!canonicalSchema ||
		JSON.stringify(canonicalSchema) !== JSON.stringify({
			start: { line: 37, column: 38 },
			end: { line: 37, column: 44 },
		}))
		fail("source_map", path, `NamedError canonical Schema obligation changed: ${JSON.stringify(canonicalSchema)}`);
	const schemaFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	let schemaNode: ts.PropertyDeclaration | undefined;
	function findSchema(node: ts.Node): void {
		if (ts.isPropertyDeclaration(node) && node.name.getText(schemaFile) === "Schema")
			schemaNode = schemaNode ? fail("source_map", path, "multiple NamedError Schema declarations") : node;
		ts.forEachChild(node, findSchema);
	}
	findSchema(schemaFile);
	const generatedSchemaOffset = javascript.indexOf("_a.Schema = schema");
	const schema = schemaNode ?? fail("source_map", path, "missing NamedError Schema declaration");
	const schemaAnchors = observations.filter((row) =>
		row.originalPos === schema.pos &&
		row.originalEnd === schema.end &&
		row.kind === ts.SyntaxKind.BinaryExpression);
	if (schemaAnchors.length !== 2 ||
		Math.max(...schemaAnchors.map((row) => row.offset)) < generatedSchemaOffset ||
		Math.min(...schemaAnchors.map((row) => row.offset)) > generatedSchemaOffset ||
		javascript.slice(Math.min(...schemaAnchors.map((row) => row.offset)), Math.max(...schemaAnchors.map((row) => row.offset))).trim() !== "_a.Schema = schema")
		fail("emitted_source", path, `NamedError Schema observer anchor is missing or moved: generated=${generatedSchemaOffset} candidates=${JSON.stringify(schemaAnchors.map((row) => ({ kind: row.kind, offset: row.offset })))}`);
	return { signature: signature(emitted.coverage), slots };
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

function receiptCounters(r: ObjectValue, data: Inputs, loaded: string[]) {
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
	return { coverage, lines };
}
function parseReceipt(value: Json, data: Inputs): ProcessReceipt {
	const root = data.selected && object(value).parent === "";
	// Bun and Node processes always carry their emission proofs (possibly none);
	// Python processes load no compiled JavaScript and carry no such field.
	const javascript = object(value).runtime !== "python";
	const r = object(value, ["id", "parent", "pid", "exitCode", "signal", "runtime", "entry", "args", "command", "lines", "trace", "children", "loaded", "coverage", ...(root ? ["cwd"] : []), ...(javascript ? ["transferred", "emitted"] : [])]);
	const loaded = array(r.loaded).map(pathValue);
	const transferred = javascript ? array(r.transferred).map(pathValue) : undefined;
	if (transferred) {
		unique(transferred, "transferred source");
		for (const path of transferred) if (!loaded.includes(path)) fail("identity", path, "transferred source was not loaded");
	}
	const { coverage, lines } = receiptCounters(r, data, loaded);
	const exitCode = nullableExit(r.exitCode);
	const signal = nullableSignal(r.signal);
	if ((exitCode === null) === (signal === null)) fail("execution", text(r.id), "invalid native terminal outcome");
	const trace = r.trace === null ? null : object(r.trace, ["id", "runtime", "python", "coverage", "flushed", "files"]);
	if (trace) verifyPythonTrace(trace, r, data, lines, coverage, loaded);
	const emitted = javascript ? array(r.emitted).map((value) => {
		const proof = object(value, ["path", "source", "project", "sha256", "mapSha256", "mapHash", "observationSha256", "observationCount", "syntheticCount"]);
		const verified = receiptEmission(data, pathValue(proof.path));
		if (!loaded.includes(verified.source) || Object.entries(verified).some(([key, value]) => proof[key] !== value))
			fail("identity", verified.path, "emitted process/source/map identity differs");
		return verified;
	}) : undefined;
	if (emitted) unique(emitted.map((proof) => proof.path), "emitted module");
	// Every source loaded through a compiled module has exactly one emission
	// proof, and every proof names such a source: provenance cannot be dropped.
	if (emitted && transferred && [...new Set(emitted.map((proof) => proof.source))].sort().join("\0") !== [...transferred].sort().join("\0"))
		fail("identity", text(r.id), "emission proofs do not match the transferred sources");
	// Both records above are the process's own claims. The frozen tree and the
	// process's own counters pin which owned compiled modules it must have
	// loaded, so erasing both records together still cannot hide one.
	if (emitted) requiredEmissions(data, loaded, emitted, coverage);
	return {
		id: text(r.id),
		parent: text(r.parent),
		pid: integer(r.pid),
		exitCode, signal, lines, trace,
		runtime: choice(r.runtime, ["bun", "node", "python"]),
		entry: pathValue(r.entry), args: array(r.args).map(text), command: text(r.command),
		...(root ? { cwd: commandDirectory(r.cwd, data.options.root) } : {}),
		children: array(r.children).map(text),
		...(transferred ? { transferred } : {}),
		...(emitted ? { emitted } : {}),
		loaded,
		coverage,
	};
}

type Site = { line: number; column: number };
// One `import(...)` / `require(...)` call: its literal specifier, or none when
// the argument is computed. A site is unproved when the counters cannot
// distinguish an evaluated call from a skipped one (a logical-assignment
// operand or an optional-chain call argument; a default parameter initializer
// has its own branch counter).
type LoadSite = Site & { specifier?: string; kind: "import" | "require"; unproved: boolean };
type ModuleSpecifiers = { static: readonly string[]; sites: readonly LoadSite[]; loader: readonly Site[] };

// The module specifiers of one module: top-level import and re-export
// declarations, every `import(...)` / `require(...)` call in source order with
// its position, and every reference through which module code could reach the
// loader outside those calls (a `require` value, `import.meta` beyond its
// path fields, `node:module`, `process.getBuiltinModule`). A literal wrapped
// in parentheses or a type-only operator is still a literal.
function moduleSpecifiers(path: string, code: string, kind: ts.ScriptKind): ModuleSpecifiers {
	const program = ts.createSourceFile(path, code, ts.ScriptTarget.ESNext, true, kind);
	const statics: string[] = [];
	const sites: LoadSite[] = [];
	const loader: Site[] = [];
	const at = (node: ts.Node): Site => {
		const { line, character } = program.getLineAndCharacterOfPosition(node.getStart(program));
		return { line: line + 1, column: character };
	};
	for (const statement of program.statements)
		if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
			statics.push(statement.moduleSpecifier.text);
			if (["module", "node:module"].includes(statement.moduleSpecifier.text)) loader.push(at(statement));
		}
	const logical = [ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken];
	const unproved = (node: ts.Node): boolean => {
		for (let child = node, parent = node.parent; parent && !ts.isBlock(parent) && !ts.isSourceFile(parent) && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
			if (ts.isBinaryExpression(parent) && parent.right === child && logical.includes(parent.operatorToken.kind)) return true;
			if (ts.isCallExpression(parent) && ts.isOptionalChain(parent) && parent.arguments.some((a) => a === child)) return true;
		}
		return false;
	};
	function visit(node: ts.Node): void {
		const call = loadCall(node);
		if (call) {
			sites.push({ ...at(node), ...call, unproved: unproved(node) });
			if (call.specifier !== undefined && ["module", "node:module"].includes(call.specifier)) loader.push(at(node));
		} else if (loaderReach(node)) loader.push(at(node));
		ts.forEachChild(node, visit);
	}
	visit(program);
	return { static: statics, sites, loader };
}

// An `import(...)`, `require(...)` or `createRequire(import.meta.url)(...)`
// call with its literal argument, or none when computed. The literal may sit
// under parentheses and type-only wrappers, in `import.meta.resolve(...)`, or
// in `new URL(..., import.meta.url)` (optionally `.href`), whose query and
// fragment the loader ignores: each names the same module the literal alone
// would.
function loadCall(node: ts.Node): Pick<LoadSite, "kind" | "specifier"> | undefined {
	if (!ts.isCallExpression(node)) return undefined;
	const callee = node.expression;
	const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
	const requires = (ts.isIdentifier(callee) && callee.text === "require") || (ts.isCallExpression(callee) && calleeName(callee.expression) === "createRequire" && isImportMetaField(callee.arguments[0], "url"));
	if (!dynamic && !requires) return undefined;
	const specifier = literalSpecifier(node.arguments[0]);
	return { kind: dynamic ? "import" : "require", ...(specifier === undefined ? {} : { specifier }) };
}

const calleeName = (node: ts.Expression) => (ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined);
const isImportMetaField = (node: ts.Node | undefined, field: string) =>
	node !== undefined && ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === field;

function literalSpecifier(node: ts.Expression | undefined): string | undefined {
	let argument = node;
	while (argument && (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument) || ts.isSatisfiesExpression(argument) || ts.isNonNullExpression(argument) || ts.isTypeAssertionExpression(argument)))
		argument = argument.expression;
	if (argument === undefined) return undefined;
	if (ts.isStringLiteralLike(argument)) return argument.text;
	if (ts.isCallExpression(argument) && isImportMetaField(argument.expression, "resolve")) return literalSpecifier(argument.arguments[0]);
	const url = ts.isPropertyAccessExpression(argument) && argument.name.text === "href" ? argument.expression : argument;
	if (ts.isNewExpression(url) && ts.isIdentifier(url.expression) && url.expression.text === "URL" && isImportMetaField(url.arguments?.[1], "url")) {
		const relative = literalSpecifier(url.arguments?.[0]);
		return relative?.replace(/[?#].*$/, "");
	}
	return undefined;
}

// Whether a node reaches the module loader outside a literal load call: the
// `require` value itself, `import.meta` beyond its path fields, or
// `getBuiltinModule`. A property named `require` is not the loader.
function loaderReach(node: ts.Node): boolean {
	if (ts.isIdentifier(node) && node.text === "require") {
		const { parent } = node;
		if (ts.isCallExpression(parent) && parent.expression === node) return false;
		const named = ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent);
		return !(named && parent.name === node);
	}
	if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
		return !(ts.isPropertyAccessExpression(node.parent) && ["url", "dir", "dirname", "file", "filename", "path", "main", "env", "hot"].includes(node.parent.name.text));
	return ts.isPropertyAccessExpression(node) && node.name.text === "getBuiltinModule";
}

const originalStaticSpecifiers = new WeakMap<Prepared, readonly string[]>();
const originalSites = new WeakMap<Prepared, readonly LoadSite[]>();
const emittedSpecifiers = new Map<string, ModuleSpecifiers>();

// Static specifiers come from the instrumented JavaScript, where type-only
// imports are already erased; load sites come from the frozen original source,
// where the mapped statement counters locate them.
function originalImports(data: Inputs, file: Prepared): { static: readonly string[]; sites: readonly LoadSite[] } {
	let statics = originalStaticSpecifiers.get(file);
	let sites = originalSites.get(file);
	if (!statics || !sites) {
		const path = file.entry.path;
		statics = moduleSpecifiers(path, file.code, ts.ScriptKind.JS).static;
		sites = moduleSpecifiers(path, content(data.options.root, path).toString("utf8"), path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS).sites;
		originalStaticSpecifiers.set(file, statics);
		originalSites.set(file, sites);
	}
	return { static: statics, sites };
}

// Whether the process's own counters prove each load site evaluated: the
// innermost mapped statement containing the call has a positive count, and so
// does the innermost mapped branch arm containing it, so an untaken ternary or
// short-circuit arm carries no obligation. `if` arms share the statement's own
// range and are located by the statements they contain instead. A call outside
// every mapped statement cannot prove it went untaken. A site the counters
// cannot decide at all fails identity rather than being credited either way.
function executedSites(data: Inputs, file: Prepared, hits: FileCoverageData): boolean[] {
	const inside = (range: Range, at: Site) =>
		(at.line > range.start.line || (at.line === range.start.line && at.column >= range.start.column)) &&
		(at.line < range.end.line || (at.line === range.end.line && at.column <= range.end.column));
	const span = (range: Range) => (range.end.line - range.start.line) * 1_000_000 + (range.end.column - range.start.column);
	const innermost = <T>(rows: readonly (readonly [T, Range])[], at: Site): T | undefined =>
		rows.filter(([, range]) => inside(range, at)).sort(([, a], [, b]) => span(a) - span(b))[0]?.[0];
	const statements = Object.entries(file.mapped.statementMap);
	const arms = Object.entries(file.mapped.branchMap).flatMap(([key, branch]) =>
		branch.type === "if" ? [] : branch.locations.map((range, index) => [[key, index] as const, range] as const));
	return originalImports(data, file).sites.map((site) => {
		if (site.unproved && site.specifier !== undefined)
			fail("identity", file.entry.path, `dynamic import at ${site.line}:${site.column} has no counter that proves it evaluated or skipped`);
		const statement = innermost(statements, site);
		const arm = innermost(arms, site);
		return (statement === undefined || (hits.s[statement] ?? 0) > 0) && (arm === undefined || (hits.b[arm[0]]?.[arm[1]] ?? 0) > 0);
	});
}

const lexicalExists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

const linkFreeRoots = new WeakSet<Inputs>();
// The inventory refuses symlinks inside the owned roots; the same tree is
// walked again at verification, so no compiled module or original can have
// been retargeted by a link between inventory and this process's loads.
function ownedTreeWithoutLinks(data: Inputs): void {
	if (linkFreeRoots.has(data)) return;
	const walk = (directory: string): void => {
		for (const name of readdirSync(directory)) {
			if (name === "node_modules") continue;
			const absolute = join(directory, name);
			const stat = lstatSync(absolute);
			if (stat.isSymbolicLink()) fail("tamper", relative(data.options.root, absolute), "owned tree holds a symlink");
			if (stat.isDirectory()) walk(absolute);
		}
	};
	for (const root of data.roots) walk(join(data.options.root, root));
	linkFreeRoots.add(data);
}

const ownedManifestNames = new WeakMap<Inputs, readonly { path: string; name: string }[]>();
// The frozen package manifests inside the owned roots, with the package names
// they declare; an owned package without a name binds no bare specifier and is
// refused. The manifest bytes are re-read under their frozen digest.
function ownedManifests(data: Inputs): readonly { path: string; name: string }[] {
	let cached = ownedManifestNames.get(data);
	if (!cached) {
		cached = data.configurations
			.filter((config) => basename(config.path) === "package.json" && !config.path.split("/").includes("node_modules") && data.roots.some((r) => config.path.startsWith(`${r}/`)))
			.map((config) => {
				const bytes = content(data.options.root, config.path);
				if (sha256(bytes) !== config.sha256) fail("tamper", config.path, "frozen package manifest differs");
				const name = object(decode(bytes.toString("utf8"))).name;
				if (typeof name !== "string") fail("identity", config.path, "frozen owned package manifest declares no name");
				return { path: config.path, name };
			});
		ownedManifestNames.set(data, cached);
	}
	return cached;
}

// The nearest `node_modules` entry for a package name above the importer,
// located with plain file-system calls rather than the resolver's cache.
function packageLink(root: string, importer: string, name: string): string | undefined {
	for (let directory = join(root, dirname(importer)); ; directory = dirname(directory)) {
		const link = join(directory, "node_modules", name);
		if (lexicalExists(link)) return link;
		if (directory === root) return undefined;
	}
}

// The link the loader follows for a bare specifier may only land where the
// frozen tree says: a link into the owned roots must reach the frozen manifest
// of that very name (an owned landing without one is refused as unfrozen
// routing below), while a dependency link stays outside the owned roots. A frozen owned name additionally pins the resolved target inside
// its package, whatever the dependency tree links now.
function ownedPackageBinding(data: Inputs, specifier: string, importer: string, target: string): void {
	const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	const link = packageLink(data.options.root, importer, name);
	let landing: string | undefined;
	if (link !== undefined) {
		try {
			landing = relative(data.options.root, realpathSync(link));
		} catch {
			fail("identity", importer, `package link ${relative(data.options.root, link)} for ${JSON.stringify(specifier)} is broken`);
		}
		if (lstatSync(link).isSymbolicLink()) {
			const owned = ownedManifests(data).find((manifest) => dirname(manifest.path) === landing);
			if (owned && owned.name !== name)
				fail("identity", importer, `package link ${relative(data.options.root, link)} for ${JSON.stringify(specifier)} aliases frozen package ${owned.path}`);
		}
	}
	for (const manifest of ownedManifests(data)) {
		if (manifest.name !== name) continue;
		const owner = dirname(manifest.path);
		if (!target.startsWith(`${owner}/`) || (landing !== undefined && landing !== owner))
			fail("identity", importer, `import ${JSON.stringify(specifier)} resolves outside frozen package ${manifest.path}`);
	}
}

// The package manifest nearest above a path: the scope the loader consults
// for a bare specifier's `imports` map or self-reference at the importer, and
// the manifest whose `exports` routed a bare specifier at the target. A path
// with no manifest above it belongs to the root's.
function nearestManifest(root: string, path: string): string {
	let directory = dirname(path);
	while (directory !== "." && !existsSync(join(root, directory, "package.json"))) directory = dirname(directory);
	return join(directory, "package.json");
}

// Resolves one specifier exactly as the loader classifies it (`require` sites
// under the require conditions, everything else under the import conditions)
// and returns the owned compiled module it names, or undefined for builtins,
// dependencies, paths outside the roots, and inventoried originals. The
// binding is checked against the frozen tree rather than the current one: a
// specifier that no longer resolves fails identity, the owned tree holds no
// symlinks, a bare specifier's importer-side package scope, when one exists,
// must be frozen, its link must land where the frozen tree says, and a bare
// specifier that lands in the owned tree also pins the package manifest that
// routed it.
function ownedEmissionTarget(data: Inputs, specifier: string, importer: string, kind: "import" | "require" = "import"): string | undefined {
	if (nodeModules.isBuiltin(specifier) || specifier.startsWith("bun:")) return undefined;
	ownedTreeWithoutLinks(data);
	const bare = !specifier.startsWith(".") && !isAbsolute(specifier);
	const from = join(data.options.root, dirname(importer));
	let resolved: string;
	try {
		resolved = realpathSync(kind === "require" ? nodeModules.createRequire(join(from, "resolve.cjs")).resolve(specifier) : Bun.resolveSync(specifier, from));
	} catch {
		return fail("identity", importer, `import ${JSON.stringify(specifier)} does not resolve in the frozen tree`);
	}
	const target = relative(data.options.root, resolved);
	const frozen = (manifest: string) => data.configurations.some((config) => config.path === manifest);
	if (bare) {
		const scope = nearestManifest(data.options.root, importer);
		if (existsSync(join(data.options.root, scope)) && !frozen(scope))
			fail("identity", importer, `package scope manifest ${scope} routing ${JSON.stringify(specifier)} is not frozen`);
		ownedPackageBinding(data, specifier, importer, target);
	}
	if (target.startsWith("..") || isAbsolute(target) || target.split("/").includes("node_modules")) return undefined;
	if (!data.roots.some((r) => target.startsWith(`${r}/`))) return undefined;
	if (bare && !frozen(nearestManifest(data.options.root, target)))
		fail("identity", importer, `package manifest ${nearestManifest(data.options.root, target)} routing ${JSON.stringify(specifier)} is not frozen`);
	if (!/\.[cm]?[jt]sx?$/.test(target) || data.files.some((f) => f.entry.path === target)) return undefined;
	return target;
}

// TypeScript may rewrite a relative `.ts` specifier to its emitted extension;
// nothing else about a literal changes between an original and its emission.
const emittedForm = (specifier: string) => specifier.replace(/\.([cm]?)tsx?$/, ".$1js");

// Every owned compiled module the process must have loaded needs an emission
// proof: the static imports of each loaded original and of each proved
// emission (resolved from the emission's own directory, so a compiled barrel
// pins its compiled dependencies), and every dynamic import the counters show
// was evaluated. An untaken dynamic import legitimately carries no proof. An
// emission's load sites are joined to its original's in source order: each
// must be the same literal at the same kind of call, so the original's
// counters decide the emission's obligations. A computed specifier or any
// other reach to the loader inside an owned emission cannot be pinned at all
// and fails identity. The converse holds as well: a proof no frozen site
// demands was loaded through a computed specifier in an original, and a
// receipt without the proof would still verify, so the process is refused at
// collection rather than left to the loader.
function requiredEmissions(data: Inputs, loaded: readonly string[], emitted: readonly EmissionProof[], coverage: ProcessReceipt["coverage"]): void {
	const demanded = new Set<string>();
	const demand = (target: string | undefined, importer: string) => {
		if (target === undefined) return;
		if (!emitted.some((proof) => proof.path === target))
			fail("identity", target, `emitted module imported by ${importer} has no emission proof`);
		demanded.add(target);
	};
	const executed = new Map<string, boolean[]>();
	const evaluated = (file: Prepared) => {
		const cached = executed.get(file.entry.path);
		if (cached) return cached;
		const flags = executedSites(data, file, coverage[file.entry.path] ?? fail("incomplete_coverage", file.entry.path, "loaded source counter record missing"));
		executed.set(file.entry.path, flags);
		return flags;
	};
	for (const path of loaded) {
		const file = data.files.find((f) => f.entry.path === path);
		if (!file || file.python) continue;
		const { static: statics, sites } = originalImports(data, file);
		for (const specifier of statics) demand(ownedEmissionTarget(data, specifier, path), path);
		const flags = evaluated(file);
		sites.forEach((site, index) => {
			if (site.specifier !== undefined && flags[index]) demand(ownedEmissionTarget(data, site.specifier, path, site.kind), path);
		});
	}
	for (const proof of emitted) {
		const key = `${proof.path}\0${proof.sha256}`;
		let specifiers = emittedSpecifiers.get(key);
		if (!specifiers) {
			specifiers = moduleSpecifiers(proof.path, content(data.options.root, proof.path).toString("utf8"), ts.ScriptKind.JS);
			emittedSpecifiers.set(key, specifiers);
		}
		const [computed] = specifiers.sites.filter((site) => site.specifier === undefined);
		if (computed) fail("identity", proof.path, `emitted module loads a computed specifier at ${computed.line}:${computed.column}; its dependencies cannot be pinned`);
		const [reach] = specifiers.loader;
		if (reach) fail("identity", proof.path, `emitted module reaches the module loader at ${reach.line}:${reach.column}; its dependencies cannot be pinned`);
		const source = data.files.find((f) => f.entry.path === proof.source) ?? fail("identity", proof.source, "emitted original absent from frozen inventory");
		const original = originalImports(data, source).sites;
		if (original.length !== specifiers.sites.length)
			fail("identity", proof.path, `emitted module has ${specifiers.sites.length} dynamic import sites where its original has ${original.length}`);
		const flags = evaluated(source);
		specifiers.sites.forEach((site, index) => {
			const counterpart = original[index] ?? fail("identity", proof.path, "emitted load site has no original");
			if (counterpart.kind !== site.kind || counterpart.specifier === undefined || (counterpart.specifier !== site.specifier && emittedForm(counterpart.specifier) !== site.specifier))
				fail("identity", proof.path, `dynamic import at ${site.line}:${site.column} differs from its original at ${counterpart.line}:${counterpart.column}`);
			if (flags[index]) demand(ownedEmissionTarget(data, site.specifier ?? "", proof.path, site.kind), proof.path);
		});
		for (const specifier of specifiers.static) demand(ownedEmissionTarget(data, specifier, proof.path), proof.path);
	}
	for (const proof of emitted)
		if (!demanded.has(proof.path))
			fail("identity", proof.path, "emitted module was loaded through a computed specifier; no frozen load site pins it");
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
		if (data.selected && (receipt.cwd !== command.cwd || receipt.entry !== command.paths[0] ||
			JSON.stringify(receipt.args) !== JSON.stringify(command.kind === "test" ? commandTestPaths(data, command).slice(1) : command.args)))
			fail("identity", command.id, "root launch differs from selected command");
		expectedRoots.add(receipt.id);
	});
	// A child's exit code is its parent test's assertion, not the collector's:
	// refusal-path CLI tests exit nonzero by design. The flushed receipt is the
	// evidence; only a normally exiting Python child can run its trace flush, so
	// only a signal-terminated one may lack it.
	for (const receipt of receipts) {
		if (receipt.runtime === "python" && receipt.trace === null && receipt.signal === null)
			fail("incomplete_coverage", receipt.id, "Python normal-completion trace was not flushed");
		verifyProcessGraph(receipt, receipts, expectedRoots);
	}
	return {
		...summary(data, receipts),
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
): { counts: Counts | number[]; key: string; slot: number; label: string }[] {
	let slot = 0;
	return [
		...Object.keys(coverage.s).map((key) => ({ counts: coverage.s, key, slot: slot++, label: `s:${key}` })),
		...Object.keys(coverage.f).map((key) => ({ counts: coverage.f, key, slot: slot++, label: `f:${key}` })),
		...Object.entries(coverage.b).flatMap(([id, counts]) =>
			Object.keys(counts).map((key) => ({ counts, key, slot: slot++, label: `b:${id}:${key}` })),
		),
	];
}

function observe(directory: string, id: string, exitCode: number | null, signal: string | null = null): void {
	writeFileSync(join(directory, `${id}.observed.json`), JSON.stringify({ exitCode, signal }), {
		flag: "wx",
	});
}

function processCounters(directory: string, id: string, files: Prepared[], emittedMaps: Map<string, EmittedTransfer[]>): void {
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
	const transferred = new Set<string>();
	const coverage: { [key: string]: FileCoverageData } = {};
	globalThis.__d945Coverage = coverage;
	for (const file of files)
		Object.defineProperty(coverage, file.entry.path, {
			enumerable: true,
			get: () => loaded.get(file.entry.path),
			set: (value: FileCoverageData) => {
				const transfer = emittedMaps.get(file.entry.path)?.find((candidate) => candidate.signature === signature(value));
				if (signature(value) !== signature(file.coverage) && !transfer)
					fail("source_map", file.entry.path, "instrumented code changed its map");
				const canonical = new Map(counterSlots(file.coverage).map((slot) => [slot.label, slot.slot]));
				for (const { counts, key, label } of counterSlots(value)) {
					const target = transfer ? transfer.slots[label] : label;
					if (target === undefined) fail("source_map", file.entry.path, `unowned emitted counter: ${label}`);
					const slot = target === null ? undefined :
						canonical.get(target) ?? fail("source_map", file.entry.path, `missing canonical counter: ${target}`);
					let ignored = 0;
					const position = slot === undefined ? undefined : (offsets.get(file.entry.path) ?? 0) + slot;
					Object.defineProperty(counts, key, {
						enumerable: true,
						configurable: false,
						get: () => position === undefined ? ignored : counters[position],
						set: (n: number) => {
							if (position === undefined) {
								ignored = integer(n);
								return;
							}
							counters[position] = integer(n);
							if (!isBun) {
								slotBytes.writeDoubleLE(n);
								if (writeSync(fd, slotBytes, 0, 8, position * 8) !== 8)
									fail("incomplete_coverage", file.entry.path, "short persistent counter write");
							}
						},
					});
				}
				loaded.set(file.entry.path, value);
				if (transfer) transferred.add(file.entry.path);
				writeFileSync(join(directory, `${id}.loaded.json`), JSON.stringify([...loaded.keys()]));
				writeFileSync(join(directory, `${id}.transferred.json`), JSON.stringify([...transferred]));
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
		...(data.selected && request.parent === "" ? { cwd: text(start.cwd) } : {}),
		trace: existsSync(tracePath) ? decode(readFileSync(tracePath, "utf8")) : null,
		children: decode(readFileSync(join(directory, `${id}.children.json`), "utf8")),
		...(text(request.runtime) === "python" ? {} : {
			transferred: decode(readFileSync(join(directory, `${id}.transferred.json`), "utf8")),
			emitted: decode(readFileSync(join(directory, `${id}.emitted.json`), "utf8")),
		}),
		loaded,
		coverage,
	};
}

// Every child that imports a compiled package re-proves the same dist files.
// The proof is keyed by the exact bytes it proved, so a sibling process reuses
// it only while the JavaScript and map are unchanged; receipt verification
// re-runs the compiler once per emitted module for each frozen input.
function sharedEmission(directory: string, data: PreloadInputs, path: string): { file: Prepared; proof: EmissionProof } {
	if (!existsSync(join(data.options.root, `${path}.map`))) return verifiedEmission(data, path);
	const javascriptSha256 = sha256(content(data.options.root, path));
	const mapSha256 = sha256(content(data.options.root, `${path}.map`));
	const cachePath = join(directory, `emitted-${sha256(`${path}\n${javascriptSha256}\n${mapSha256}`)}.json`);
	if (existsSync(cachePath)) {
		const cached = object(decode(readFileSync(cachePath, "utf8")), ["file", "proof"]);
		if (cached.file === undefined) fail("schema", path, "expected object");
		const proof = object(cached.proof, ["path", "source", "project", "sha256", "mapSha256", "mapHash", "observationSha256", "observationCount", "syntheticCount"]);
		const count = (value: Json | undefined): number =>
			typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fail("schema", path, "expected count");
		return {
			file: preparedFrom(cached.file),
			proof: {
				path: pathValue(proof.path), source: pathValue(proof.source), project: pathValue(proof.project),
				sha256: hash(proof.sha256), mapSha256: hash(proof.mapSha256), mapHash: hash(proof.mapHash),
				observationSha256: hash(proof.observationSha256), observationCount: count(proof.observationCount), syntheticCount: count(proof.syntheticCount),
			},
		};
	}
	const emitted = verifiedEmission(data, path);
	// Worker threads share the PID, so the temporary name carries the thread too.
	const temporary = `${cachePath}.${process.pid}.${workerThreads.threadId}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(emitted));
	renameSync(temporary, cachePath);
	return emitted;
}
// The preload is built outside the owned tree so the gate's actual CLI source
// remains instrumentable. Bun.spawn is interposed before owned code imports it.
export function preload(directory: string): void {
	if (ts.version !== "5.9.2") fail("toolchain", "", "TypeScript must be 5.9.2");
	const data = preloadInputsFrom(decode(readFileSync(join(directory, "inputs.json"), "utf8")));
	const id = process.env.D945_PROCESS ?? fail("process", "", "missing process identity");
	const parent = process.env.D945_PARENT ?? "";
	const children: string[] = [];
	const startPath = join(directory, `${id}.start.json`);
	const request = object(decode(readFileSync(join(directory, `${id}.request.json`), "utf8")));
	const runtime = typeof Bun === "undefined" ? "node" : "bun";
	const cwd = relative(data.options.root, realpathSync(process.cwd())) || ".";
	if (data.selected && parent === "" && request.cwd !== cwd) fail("identity", id, "root cwd differs from launch request");
	writeFileSync(startPath, JSON.stringify({ id, parent, pid: process.pid, runtime, entry: text(request.entry), ...(data.selected && parent === "" ? { cwd } : {}) }), { flag: "wx" });
	writeFileSync(join(directory, `${id}.children.json`), "[]", { flag: "wx" });
	writeFileSync(join(directory, `${id}.loaded.json`), "[]", { flag: "wx" });
	writeFileSync(join(directory, `${id}.emitted.json`), "[]", { flag: "wx" });
	writeFileSync(join(directory, `${id}.transferred.json`), "[]", { flag: "wx" });
	const emittedMaps = new Map<string, EmittedTransfer[]>();
	const emissions = new Map<string, EmissionProof>();
	processCounters(directory, id, data.files, emittedMaps);
	function loadedCode(absolute: string): string | undefined {
		const path = relative(data.options.root, absolute);
		const file = data.files.find((f) => f.entry.path === path);
		if (file) {
			if (sha256(content(data.options.root, path)) !== file.entry.sha256)
				fail("tamper", path, "source changed after preparation");
			return file.code;
		}
		if (!data.roots.some((r) => path.startsWith(`${r}/`)) || path.split("/").includes("node_modules")) return undefined;
		const emitted = sharedEmission(directory, data, path);
		if (!emitted.file.transfer) fail("source_map", path, "emitted transfer proof is missing");
		emittedMaps.set(emitted.proof.source, [...(emittedMaps.get(emitted.proof.source) ?? []), emitted.file.transfer]);
		emissions.set(path, emitted.proof);
		writeFileSync(join(directory, `${id}.emitted.json`), JSON.stringify([...emissions.values()]));
		return emitted.file.code;
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
		if (launch.id === undefined) return launch;
		children.push(childId);
		writeFileSync(join(directory, `${id}.children.json`), JSON.stringify(children));
		return launch;
	}
	installProcessHooks(child, (childId, code, signal) => observe(directory, childId, code, signal), fail);
	installWorkerHooks(
		(filename, options) => {
			if (options?.env === workerThreads.SHARE_ENV)
				fail("unsupported_process", id, "worker SHARE_ENV is not observable");
			if (options?.eval === true)
				fail("unsupported_process", id, "worker eval is not observable");
			const target = typeof filename === "string" ? pathToFileURL(resolve(process.cwd(), filename)) : filename;
			if (target.protocol !== "file:") fail("unsupported_process", id, "worker target must be a file URL");
			const targetPath = relative(data.options.root, fileURLToPath(target));
			const entry = data.files.find((file) => file.entry.path === targetPath) ??
				fail("unsupported_process", targetPath, "worker target is absent from frozen language inventory");
			const childId = randomUUID();
			const runtime = typeof Bun === "undefined" ? "node" : "bun";
			const version = runtime === "node" ? `v${process.versions.node}` : Bun.version;
			writeFileSync(join(directory, `${childId}.request.json`), JSON.stringify({
				parent: id, command: text(request.command), runtime, entry: entry.entry.path, args: [],
				binary: process.execPath, version, sha256: sha256(readFileSync(process.execPath)),
			}), { flag: "wx" });
			children.push(childId);
			writeFileSync(join(directory, `${id}.children.json`), JSON.stringify(children));
			const environment = {
				...(options?.env === undefined ? process.env : options.env),
				D945_DIRECTORY: directory, D945_PROCESS: childId, D945_PARENT: id,
				D945_ASSET_DIRECTORY: directory, D945_PYTHON: pythonBinary(), D945_BUN: process.env.D945_BUN ?? process.execPath,
			};
			sourceRoot(data, environment);
			const baseOptions = options ?? {};
			if (runtime === "node") return { id: childId, filename: target, options: { ...baseOptions, env: environment, execArgv: workerExecArgv(options?.execArgv ?? process.execArgv, pathToFileURL(join(directory, "preload.mjs")).href) } };
			const bootstrap = join(directory, `${childId}.worker.mjs`);
			writeFileSync(bootstrap, `import ${JSON.stringify(pathToFileURL(join(directory, "preload.js")).href)};\nawait import(${JSON.stringify(target.href)});\n`, { flag: "wx" });
			return { id: childId, filename: bootstrap, options: { ...baseOptions, env: environment } };
		},
		(childId, code) => observe(directory, childId, code, null),
		fail,
	);
	if (runtime === "node") return;
	// Interposition consumes only argv/environment. Native stdio, IPC payloads,
	// callbacks and return values pass through untouched; they are not analyzer data.
	type LaunchOptions = { env?: NodeJS.ProcessEnv; cwd?: string; shell?: boolean | string };
	const spawn = Bun.spawn;
	const spawnSync = Bun.spawnSync;
	function bunLaunch(command: string[] | (LaunchOptions & { cmd: string[] }), options?: LaunchOptions) {
		const opts = Array.isArray(command) ? options : command;
		const argv = Array.isArray(command) ? command : command.cmd;
		if (opts?.shell) fail("unsupported_process", argv[0] ?? "", "shell execution is not observable");
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
// An executable that does not resolve runs nothing, so the operating system's refusal
// (ENOENT) is the caller's real observation; the collector does not replace it.
function binaryPath(binary: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
	const path = binary.includes("/") ? resolve(cwd, binary) : (env.PATH ?? "").split(":").map((p) => join(p, binary)).find(existsSync);
	return path === undefined || !existsSync(path) ? undefined : resolve(path);
}
// Native utilities execute without receipts and never earn coverage credit. A shell may
// hide an owned runtime from observation, which only loses credit; it can never fabricate it.
// Matched by basename: Bun's node:child_process re-enters Bun.spawnSync with the already
// canonical path, so the second interposition must recognize the same utility.
const OWNED_RUNTIMES = /^(?:bun|node)(?:\.exe)?$|^python(?:3(?:\.\d+)?)?$/;
// A non-runtime executable outside the frozen root (a system utility, a platform tool such
// as launchctl, or a fixture stand-in written to a throwaway HOME) runs natively: it earns
// no credit and leaves no receipt, so it cannot inflate the measurement. Inside the root
// only owned runtimes on frozen inventory may run.
function utilityPath(executable: string, binary: string, root: string): string | undefined {
	if (OWNED_RUNTIMES.test(basename(binary))) return undefined;
	const canonical = realpathSync(binary);
	if (!relative(realpathSync(root), canonical).startsWith("..")) fail("unsupported_process", executable, "unregistered native executable");
	return binary;
}
// A selected collection pins the root every top-level Python launch is checked against. An
// unselected collection (a fixture repository driven by a test that itself runs under a selected
// outer collector) must not inherit the outer root, or its root cwd check compares against the
// wrong repository.
function sourceRoot(data: PreloadInputs, env: Record<string, string | undefined>): void {
	if (data.selected) env.D945_SOURCE_ROOT = data.options.root;
	else delete env.D945_SOURCE_ROOT;
}
// An owned runtime launched on an entry outside the frozen root (a gate copied into a
// throwaway fixture repository) runs natively: like a utility it earns no credit and
// leaves no receipt, whatever interpreter options it carries (the mutation runner's
// `--smol test --reporter=junit` copies). Entries inside the root must still be frozen
// inventory launched with recognized options only.
const VALUE_OPTIONS = ["--timeout", "--import", "--require", "-r"];
const NEUTRAL_OPTIONS = ["-u", "--no-warnings", "--enable-source-maps"];
// Python isolated mode changes what the entry sees (no PYTHON* environment, no user site,
// no script directory on sys.path), so the driver interpreter is launched with it too.
const FORWARDED_PYTHON_OPTIONS = ["-I"];
type Launch<E = Prepared> = { entry: E; args: string[]; interpreter: string[] } | { external: string };
// A launch is resolved against the frozen files alone, relative to the frozen root.
type LaunchInputs = { options: Pick<Options, "root">; files: Prepared[] };
// `python -c text`: the text is a frozen Python source or it is not an entry at all.
// Inline program text that is not a frozen Python source (a test's native control
// program) has no entry to credit: it runs natively, like an external entry,
// whatever interpreter options (`-I`) precede it.
function inlinePythonEntry(data: LaunchInputs, argv: string[], executable: string): Launch<Prepared | undefined> {
	const index = argv.indexOf("-c");
	const source = argv[index + 1];
	const entry = data.files.find((f) => f.python?.source === source);
	if (entry === undefined) return { external: executable };
	if (argv.slice(0, index).some((a) => a !== "-u")) fail("unsupported_process", executable, "unrecognized Python interpreter option");
	return { entry, args: argv.slice(index + 2), interpreter: [] };
}
// The interpreter options before the program (`test` opens Bun's subcommand once;
// a valued option consumes the next argument). Inline program text (`-e`, `-p`) has
// no frozen entry: the launch runs natively, like an external entry.
function leadingOptions(argv: string[], runtime: string, valued: string[]): { options: string[]; index: number; inline: boolean } {
	let index = 0;
	const options: string[] = [];
	for (let subcommand = false; argv[index]?.startsWith("-") || (argv[index] === "test" && !subcommand);) {
		if (argv[index] === "test") { subcommand = true; index++; continue; }
		const flag = argv[index++] ?? "";
		if (runtime !== "python" && ["-e", "--eval", "-p", "--print"].includes(flag)) return { options, index, inline: true };
		options.push(flag);
		if (valued.includes(flag)) index++;
	}
	return { options, index, inline: false };
}
// The program named after the interpreter options, as the frozen entry at its path
// unless it runs natively: an option-only invocation (`python3 --version`, a runtime
// probe) launches no program at all; a program outside the frozen root or a
// dependency's own program (knip, a vendored CLI) is never frozen inventory.
function programEntry(data: LaunchInputs, argv: string[], runtime: string, executable: string, cwd: string): Launch<Prepared | undefined> {
	const valued = [...VALUE_OPTIONS, ...(runtime === "bun" ? ["--preload"] : [])];
	const { options, index, inline } = leadingOptions(argv, runtime, valued);
	const program = argv[index];
	if (inline || program === undefined) return { external: executable };
	const absolute = resolve(cwd, program);
	const path = relative(data.options.root, absolute);
	if ((path.startsWith("..") || path.split(sep).includes("node_modules")) && existsSync(absolute)) return { external: absolute };
	const forwarded = runtime === "python" ? FORWARDED_PYTHON_OPTIONS : [];
	const unregistered = options.find((flag) => !valued.includes(flag) && !NEUTRAL_OPTIONS.includes(flag) && !forwarded.includes(flag));
	if (unregistered !== undefined) fail("unsupported_process", executable, `unregistered interpreter option ${unregistered}`);
	return { entry: data.files.find((f) => f.entry.path === path), args: argv.slice(index + 1), interpreter: options.filter((flag) => forwarded.includes(flag)) };
}
export function launchEntry(data: LaunchInputs, argv: string[], runtime: string, executable: string, cwd: string): Launch {
	const launch = runtime === "python" && argv.includes("-c") ? inlinePythonEntry(data, argv, executable) : programEntry(data, argv, runtime, executable, cwd);
	if ("external" in launch) return launch;
	const { entry, args, interpreter } = launch;
	if (!entry || (runtime === "python") !== Boolean(entry.python))
		fail("unsupported_process", executable, "entry/source is absent from frozen language inventory");
	return { entry, args, interpreter };
}

function runtimeVersion(binary: string, runtime: string, executable: string): string {
	const version = analyzerProcess(binary, ["--version"]);
	const actual = version.stdout.trim();
	if (version.status !== 0 || (runtime === "bun" && !["1.3.6", "1.4.1"].includes(actual)) ||
		(runtime === "node" && actual !== "v24.19.0") || (runtime === "python" && actual !== "Python 3.12.12"))
		fail("toolchain", executable, `unsupported native runtime ${actual}`);
	return actual;
}

function launchCommand(data: PreloadInputs, directory: string, id: string, parent: string, commandId: string,
	command: string[], environment: NodeJS.ProcessEnv, cwd: string): { id?: string; command: string[]; env: NodeJS.ProcessEnv } {
	const executable = command[0] ?? fail("process", "", "empty executable");
	const binary = binaryPath(executable, environment, cwd);
	if (binary === undefined) return { command, env: environment };
	const utility = utilityPath(executable, binary, data.options.root);
	if (utility !== undefined) return { command: [utility, ...command.slice(1)], env: environment };
	const name = basename(binary);
	const runtime = /^bun(?:\.exe)?$/.test(name) ? "bun" : /^node(?:\.exe)?$/.test(name) ? "node" : "python";
	let argv = command.slice(1);
	if (runtime === "bun" && argv[0] === "run") argv = argv.slice(1);
	const launched = launchEntry(data, argv, runtime, executable, cwd);
	if ("external" in launched) return { command: [binary, ...command.slice(1)], env: environment };
	const { entry, args, interpreter } = launched;
	const actual = runtimeVersion(binary, runtime, executable);
	writeFileSync(join(directory, `${id}.request.json`), JSON.stringify({ parent, command: commandId, runtime, entry: entry.entry.path, args, binary, version: actual, sha256: sha256(readFileSync(binary)), ...(data.selected && parent === "" ? { cwd: relative(data.options.root, cwd) || "." } : {}) }), { flag: "wx" });
	const env = {
		...environment, D945_DIRECTORY: directory, D945_PROCESS: id, D945_PARENT: parent,
		D945_ASSET_DIRECTORY: directory, D945_PYTHON: pythonBinary(), D945_BUN: process.env.D945_BUN ?? process.execPath,
	};
	sourceRoot(data, env);
	// The Python runner executes from this copy, like the preload: its own frames run inside every traced region
	// and must never be credited to the frozen script/quality-coverage/python.py it was copied from.
	if (runtime === "python") return { id, command: [binary, ...interpreter, "-u", join(directory, "python.py"), "run", directory, id, entry.entry.path, ...args], env };
	if (runtime === "node") return { id, command: [binary, "--import", pathToFileURL(join(directory, "preload.mjs")).href, ...argv], env };
	return { id,
		command: argv[0] === "test" ? [binary, "test", "--preload", join(directory, "preload.js"), ...argv.slice(1)] :
			[binary, "--preload", join(directory, "preload.js"), ...argv], env
	};
}
function commandTestPaths(data: Inputs, command: Command): string[] {
	const cwd = resolve(data.options.root, command.cwd ?? ".");
	return command.paths.map((path) => `./${relative(cwd, resolve(data.options.root, path))}`);
}
// The collector's output is the only record of a failed lane, so it keeps the
// error block above each failing test instead of an arbitrary tail.
const FAILURE_EXCERPT_LIMIT = 16_000;
export function failureExcerpt(stderr: string): string {
	const lines = stderr.split("\n");
	const blocks: string[] = [];
	let start = 0;
	for (const [index, line] of lines.entries()) {
		if (/^\((pass|skip|todo)\)/.test(line) || /^\S+\.(test|spec)\.[cm]?[jt]sx?:$/.test(line)) start = index + 1;
		if (line.startsWith("(fail)")) {
			blocks.push(lines.slice(start, index + 1).join("\n"));
			start = index + 1;
		}
	}
	const excerpt = blocks.length ? blocks.join("\n\n") : stderr;
	return excerpt.length > FAILURE_EXCERPT_LIMIT ? excerpt.slice(-FAILURE_EXCERPT_LIMIT) : excerpt;
}
// Hang guard for one instrumented command, not a performance budget: instrumented
// tooling shards exceed ten minutes on hosted runners; the job timeout owns the total.
const COMMAND_DEADLINE_MS = 1_500_000;
async function collectCommand(data: Inputs, directory: string, command: Command): Promise<Json> {
	const id = randomUUID();
	const cwd = resolve(data.options.root, command.cwd ?? ".");
	const argv =
		command.kind === "test"
			? ["test", "--timeout", "15000", ...commandTestPaths(data, command)]
			: [join(data.options.root, command.paths[0] ?? ""), ...command.args];
	const runtime = command.runtime ?? "bun";
	const executable = runtime === "bun" ? process.execPath : runtime === "python" ? pythonBinary() : "node";
	const launch = launchCommand(data, directory, id, "", command.id, [executable, ...argv], process.env, cwd);
	const child = Bun.spawn(launch.command, {
		cwd,
		env: launch.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	let deadline = false;
	const timeout = setTimeout(() => { deadline = true; child.kill("SIGKILL"); }, COMMAND_DEADLINE_MS);
	const exitCode = await child.exited;
	clearTimeout(timeout);
	observe(directory, id, child.signalCode ? null : exitCode, signalName(child.signalCode));
	const out = await stdout;
	const err = await stderr;
	if (deadline || child.signalCode || exitCode !== command.expectedExitCode) {
		const outcome = deadline ? `killed at the ${COMMAND_DEADLINE_MS}ms command deadline` : `exit ${exitCode}`;
		fail(
			"execution",
			command.id,
			`${outcome}; stdout=${out.slice(-2000)} stderr=${failureExcerpt(err)}`,
		);
	}
	if (command.kind === "test" && !/[1-9]\d* pass/.test(err))
		fail("execution", command.id, "no successful test selection");
	return { id: command.id, process: id, exitCode };
}

// The directory every instrumented process of one collection reads: the prepared
// inventory, both runtime preloads, the Python runner and the dependency tree.
async function prepareCollector(data: Inputs, directory: string): Promise<void> {
	writeFileSync(join(directory, "inputs.json"), JSON.stringify(preloadInputs(data)));
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
	copyFileSync(asset("python.py"), join(directory, "python.py"));
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
}
/** A prepared collector directory for `paths`, so a test can run `preload` for
 * one process identity inside its own runtime; the caller removes the directory. */
export async function collectorDirectory(paths: FrozenPaths): Promise<string> {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "openomni-d945-coverage-")));
	await prepareCollector(frozenInputs(paths), directory);
	return directory;
}

async function collect(data: Inputs): Promise<Json> {
	if (!["1.3.6", "1.4.1"].includes(Bun.version)) fail("toolchain", "", "unsupported Bun version");
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "openomni-d945-coverage-")));
	try {
		await prepareCollector(data, directory);
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
				if (text(start.parent) !== "") continue;
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

type FrozenPaths = { root: string; contract: string; inventory: string; plan: string };
function frozenInputs(paths: FrozenPaths): Inputs {
	return inputs({
		root: realpathSync(paths.root),
		contract: resolve(paths.contract), contractHash: sha256(readFileSync(paths.contract)),
		inventory: resolve(paths.inventory), inventoryHash: sha256(readFileSync(paths.inventory)),
		plan: resolve(paths.plan), planHash: sha256(readFileSync(paths.plan)),
	});
}
export function coverageForMetrics(paths: FrozenPaths & { coverage: string }) {
	const data = frozenInputs(paths);
	const input = decode(readFileSync(paths.coverage, "utf8"));
	verify(input, data);
	return {
		files: data.files.map((file) => ({ path: file.entry.path, sha256: file.entry.sha256, mapped: file.mapped })),
		processes: array(object(input).processes).map((receipt) => parseReceipt(receipt, data)),
	};
}

// A pipe reader may receive a cut multi-megabyte verdict; the file written before
// the stdout pointer is the complete document, and the pointer names its bytes.
function writeResult(result: ReturnType<typeof verify>, path: string | undefined) {
	if (path === undefined) return result;
	const encoded = JSON.stringify(result);
	writeFileSync(path, encoded, { flag: "wx" });
	return { complete: result.complete, exitCode: result.exitCode, aggregate: result.aggregate, result: path, resultSha256: sha256(encoded) };
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
				"write-result": { type: "string" },
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
		// rejects the receipt. Writing a receipt does not mark it complete.
		if (values["write-coverage"]) writeFileSync(values["write-coverage"], JSON.stringify(input));
		const result = verify(input, data);
		console.log(JSON.stringify(writeResult(result, values["write-result"])));
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
	instrumented = true;
	preload(process.env.D945_DIRECTORY);
} else if (import.meta.main) process.exitCode = await qualityCoverageMain();
