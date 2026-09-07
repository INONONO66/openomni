import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { productionConsumerFindings, runProductionKnip } from "./check-dead-exports";
import { ledgerCensusOwner, ledgerCensusRole, ledgerCensusSchemaCompiler, ledgerCensusSchemaOrigins, liveCensusTables } from "./ledger-producer-manifest";
import { knipWorkspaces } from "./topology";
import { qualitySource } from "./quality-source";
import { decodeJson, parseEntry } from "./quality-inventory";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type CensusClass = "publisher" | "export" | "store";
type Locus = { path: string; line: number; symbol: string };
type Problem = Locus & { code: string; declarationOwner?: string; valueOrigins?: Locus[] };
type Entry = { path: string; sha256: string; bytes: number; category: string; language: string };
type Edge = { originDefinition: Locus; importOrAliasPath: Locus[]; forwardingCallPath: Locus[]; terminalProductOperation: Locus; rootInvocation: Locus; operationKind?: string };
type Finding = Locus & { class: CensusClass };
type EventContext = { sites: ts.Node[]; bindings: Map<ts.ParameterDeclaration, ts.Expression> };
class CensusFailure {
	constructor(readonly code: string, readonly path: string, readonly message: string) { }
}
let lastFailure: CensusFailure | undefined;
function fail(code: string, path: string, message: string): never {
	lastFailure = new CensusFailure(code, path, message);
	throw lastFailure;
}
function digest(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function object(value: Json | undefined): { [key: string]: Json } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail("schema", "", "expected object");
	return value;
}
function array(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) return fail("schema", "", "expected array");
	return value;
}
function string(value: Json | undefined): string {
	if (typeof value !== "string") return fail("schema", "", "expected string");
	return value;
}
function exact(value: { [key: string]: Json }, keys: string[]): void {
	if (Object.keys(value).sort().join() !== keys.sort().join()) fail("schema", "", "unexpected or missing fields");
}
// Do not consume JSON.parse's top-typed payload. Decode only the JSON AST grammar.
function decode(text: string): Json {
  try { return decodeJson(text); }
  catch { return fail("schema", "", "invalid JSON"); }
}
function readJson(path: string): Json { return decode(readFileSync(path, "utf8")); }
function sourcePath(root: string, path: string): string {
	if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) fail("schema", path, "relative path required");
	const absolute = resolve(root, path);
	if (relative(root, realpathSync(absolute)).startsWith("..")) fail("inventory", path, "source escapes root");
	return absolute;
}
function checked(root: string, path: string, hash: string): Buffer {
	if (!/^[a-f0-9]{64}$/.test(hash)) return fail("schema", path, "sha256 required");
	const bytes = readFileSync(sourcePath(root, path));
	if (digest(bytes) !== hash) return fail("tamper", path, "content hash differs");
	return bytes;
}
function readEntry(value: Json): Entry {
  try { return parseEntry(value); }
  catch { return fail("schema", "", "invalid source entry"); }
}
function eligible(row: Entry): boolean {
	return row.category === "production" && !row.path.endsWith(".d.ts");
}
function loadInput(root: string, inventoryPath: string, hash: string, contractPath: string) {
	const raw = checked(root, inventoryPath, hash);
	const inventory = object(decode(raw.toString()));
	exact(inventory, ["version", "contractHash", "files", "historical", "embedded", "configurations"]);
	const contract = object(readJson(sourcePath(root, contractPath)));
	exact(contract, ["version", "typescript", "roots", "projects", "topology"]);
	if (inventory.version !== 1 || contract.version !== 1 || contract.typescript !== "5.9.2" || typeof contract.topology !== "boolean") fail("schema", contractPath, "unsupported contract");
	const roots = array(contract.roots).map(string), projects = array(contract.projects).map(string);
	// Reproduce the canonical contract serialization, not its source scanner.
	const normalized = { version: 1, typescript: "5.9.2", roots, projects, topology: contract.topology };
	if (inventory.contractHash !== digest(JSON.stringify(normalized))) fail("tamper", contractPath, "contract hash differs");
	const files = array(inventory.files).map(readEntry), historical = array(inventory.historical).map(readEntry);
	if (!files.length || !projects.length || !roots.length) fail("incomplete_inventory", "", "empty source/project inventory");
	const names = new Set<string>();
	for (const row of [...files, ...historical]) {
		if (names.has(row.path)) fail("incomplete_inventory", row.path, "duplicate source");
		names.add(row.path);
		if (checked(root, row.path, row.sha256).length !== row.bytes) fail("tamper", row.path, "byte count differs");
	}
	for (const row of files) if (!roots.some((prefix) => row.path.startsWith(`${prefix}/`))) fail("schema", row.path, "source outside ownership roots");
	const configurations = array(inventory.configurations).map((item) => {
		const config = object(item); exact(config, ["path", "sha256"]);
		const path = string(config.path); checked(root, path, string(config.sha256)); return path;
	});
	for (const project of projects) if (!configurations.includes(project)) fail("incomplete_inventory", project, "missing project configuration");
	const { embedded, embeddedText } = loadEmbedded(inventory, names, root);
	return { files, projects, topology: contract.topology, embedded, embeddedText, inventoryHash: digest(raw), contractHash: string(inventory.contractHash) };
}
function loadEmbedded(inventory: { [key: string]: Json; }, names: Set<string>, root: string) {
	const embedded = array(inventory.embedded).map(readEntry);
	const embeddedText = new Map<string, string>();
	for (const row of embedded) {
		const [host, symbol, extra] = row.path.split("#");
		if (!host || !symbol || extra || row.language !== "python" || !names.has(host)) fail("schema", row.path, "invalid embedded source identity");
		const source = ts.createSourceFile(host, readFileSync(sourcePath(root, host), "utf8"), ts.ScriptTarget.Latest, true);
		const matches: string[] = [];
		walk(source, (node) => {
			if (!ts.isVariableDeclaration(node) || node.name.getText() !== symbol || !node.initializer) return;
			const value = node.initializer;
			if (ts.isTaggedTemplateExpression(value) && value.tag.getText() === "String.raw" && ts.isNoSubstitutionTemplateLiteral(value.template) && value.template.rawText !== undefined) matches.push(value.template.rawText);
		});
		const text = matches[0];
		if (matches.length !== 1 || text === undefined || digest(text) !== row.sha256 || Buffer.byteLength(text) !== row.bytes) fail("tamper", row.path, "embedded source differs");
		embeddedText.set(row.path, text);
	}
	return { embedded, embeddedText };
}

function unwrap(node: ts.Node): ts.Node {
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return unwrap(node.expression);
	return node;
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
	visit(node); ts.forEachChild(node, (child) => walk(child, visit));
}
const isFunction = ts.isFunctionLike;
function implementation(node: ts.Node): boolean {
	return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && !!node.body;
}
function scope(node: ts.Node): ts.Node {
	let current = node.parent;
	while (current && !ts.isSourceFile(current) && !isFunction(current)) current = current.parent;
	return current ?? node;
}
function memberName(node: ts.Node): string {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
	if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
	return "";
}
function makeProgram(root: string, files: Entry[], projects: string[]) {
	const paths: Record<string, string[]> = {};
	for (const workspace of knipWorkspaces()) paths[workspace.packageName] = [join(root, workspace.dir, "src/index.ts")];
	const bunTypes = Bun.resolveSync("@types/bun/package.json", import.meta.dir);
	if (object(readJson(bunTypes)).version !== "1.3.12") fail("tool_version", bunTypes, "Bun declarations require 1.3.12");
	const options: ts.CompilerOptions = { types: ["bun"], typeRoots: [dirname(dirname(bunTypes))], strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, jsx: ts.JsxEmit.Preserve, noEmit: true, baseUrl: root, paths, skipLibCheck: true };
	const membership = new Set(files.map((row) => resolve(root, row.path)));
	for (const project of projects) {
		const host = ts.createWatchCompilerHost(resolve(root, project), {}, {
			...ts.sys, watchFile: () => ({ close: () => undefined }), watchDirectory: () => ({ close: () => undefined }),
		}, ts.createSemanticDiagnosticsBuilderProgram, () => fail("configuration", project, "invalid TS project"), () => undefined);
		host.afterProgramCreate = () => undefined;
		host.onUnRecoverableConfigFileDiagnostic = () => fail("configuration", project, "unreadable TS project");
		const watch = ts.createWatchProgram(host);
		try {
			const config = watch.getProgram().getProgram();
			if (config.getConfigFileParsingDiagnostics().length) fail("configuration", project, "invalid TS project");
			for (const path of config.getRootFileNames()) if (!membership.has(resolve(path))) fail("incomplete_inventory", relative(root, path), "project source omitted from inventory");
		} finally { watch.close(); }
	}
	const program = ts.createProgram(files.filter((row) => ["typescript", "javascript"].includes(row.language)).map((row) => resolve(root, row.path)), options);
	const syntax = program.getSyntacticDiagnostics();
	if (syntax.length) fail("unsupported_syntax", syntax[0]?.file?.fileName ?? "", "source syntax is invalid");
	for (const source of program.getSourceFiles()) {
		if (!source.isDeclarationFile && !source.fileName.endsWith(".json") && !source.fileName.includes("/node_modules/") && !membership.has(resolve(source.fileName))) fail("incomplete_inventory", relative(root, source.fileName), "resolved source omitted from inventory");
	}
	return program;
}
function productionRoots(root: string, files: Entry[], qualityOnly = false) {
	const manifests = new Set<string>();
	for (const row of files) {
		let path = dirname(resolve(root, row.path));
		while (!relative(root, path).startsWith("..")) {
			if (existsSync(join(path, "package.json"))) manifests.add(join(path, "package.json"));
			if (path === root) break;
			path = dirname(path);
		}
	}
	const entries = new Map<string, Locus>();
	const configurationHashes: { path: string; sha256: string }[] = [];
	for (const manifest of [...manifests].sort()) {
		const content = readFileSync(manifest, "utf8"), config = object(decode(content));
		configurationHashes.push({ path: relative(root, manifest), sha256: digest(content) });
		discoverManifestEntries(config, manifest);
		const bins = typeof config.bin === "string" ? [config.bin] : config.bin === undefined ? [] : Object.values(object(config.bin)).map(string);
		for (const bin of bins) {
			const path = resolve(dirname(manifest), bin);
			if (!files.some((row) => resolve(root, row.path) === path && eligible(row))) fail("root_classification", bin, "bin must resolve to inventoried source, not unverified generated output");
			entries.set(path, { path: relative(root, manifest), line: 1, symbol: "bin" });
		}
	}
	const workflow = join(root, ".github/workflows/ci.yml");
	discoverWorkflowRoots();
	if (!entries.size) fail("missing_roots", "", "no executable package script or bin root");
	return { entries, configurationHashes };

	function discoverWorkflowRoots() {
		if (existsSync(workflow)) {
			const content = readFileSync(workflow, "utf8");
			configurationHashes.push({ path: ".github/workflows/ci.yml", sha256: digest(content) });
			for (const match of content.matchAll(/(?:^|\n)[ \t]*(?:-?\s*run:\s*)?(?:bun|node|tsx)\s+(?:run\s+)?(script\/[\w./-]+\.[cm]?[jt]sx?)([^\n]*)/g)) {
				if (/--self-test|--coverage|--test/.test(match[2] ?? "")) continue;
				const path = match[1] ?? "";
				if (qualityOnly && files.some((row) => row.path === path && row.category === "tooling")) continue;
				if (!files.some((row) => row.path === path && eligible(row))) fail("incomplete_inventory", path, "CI operational root absent");
				entries.set(resolve(root, path), { path: ".github/workflows/ci.yml", line: content.slice(0, match.index).split("\n").length, symbol: match[0].trim() });
			}
		}
	}

	function discoverManifestEntries(config: { [key: string]: Json; }, manifest: string) {
		const scripts = config.scripts === undefined ? {} : object(config.scripts);
		discoverScriptRoots();
		discoverApplicationRoots();

		function discoverScriptRoots() {
			for (const [name, command] of Object.entries(scripts)) {
				if (/test|bench|fixture|coverage|mutation/.test(name)) continue;
				for (const match of string(command).matchAll(/(?:^|[\s;&])(?:bun|node|tsx|python3?)\s+(?:run\s+)?(?:--[\w-]+\s+)*([\w./-]+\.(?:[cm]?[jt]sx?|py))(?=\s|$)/g)) {
					const path = resolve(dirname(manifest), match[1] ?? "");
					if (qualityOnly && !qualitySource(relative(root, path))) continue;
					const row = files.find((file) => resolve(root, file.path) === path);
					if (!row) fail("incomplete_inventory", relative(root, path), "operational entry missing from inventory");
					if (qualityOnly && row.category === "tooling") continue;
					if (!eligible(row)) fail("root_classification", row.path, "nonproduction operational entry");
					entries.set(path, { path: relative(root, manifest), line: 1, symbol: `scripts.${name}: ${command}` });
				}
			}
		}

		function discoverApplicationRoots() {
			if (Object.values(scripts).some((command) => typeof command === "string" && /(?:^|[\s;&])electron-vite\s+(?:dev|build|preview)(?:\s|$)/.test(command))) {
				const configuration = files.find((row) => resolve(root, row.path) === join(dirname(manifest), "electron.vite.config.ts"));
				if (!configuration) fail("missing_roots", relative(root, manifest), "electron-vite configuration missing from inventory");
				const file = ts.createSourceFile(configuration.path, readFileSync(sourcePath(root, configuration.path), "utf8"), ts.ScriptTarget.Latest, true);
				entries.set(resolve(root, configuration.path), { path: relative(root, manifest), line: 1, symbol: "electron-vite" });
				walk(file, (node) => {
					if (!ts.isPropertyAssignment(node) || !["entry", "input"].includes(memberName(node.name))) return;
					if (!ts.isStringLiteralLike(node.initializer)) fail("dynamic_application_entry", configuration.path, "electron-vite entry must be concrete");
					const configured = resolve(dirname(manifest), node.initializer.text);
					const invocation = { path: configuration.path, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, symbol: node.getText() };
					const paths: string[] = [];
					if (configured.endsWith(".html")) {
						const htmlPath = relative(root, configured), html = readFileSync(sourcePath(root, htmlPath), "utf8");
						configurationHashes.push({ path: htmlPath, sha256: digest(html) });
						for (const tag of html.matchAll(/<script\b([^>]*)>/g)) {
							if (!/\btype=["']module["']/.test(tag[1] ?? "")) continue;
							const src = /\bsrc=["']([^"']+)["']/.exec(tag[1] ?? "")?.[1];
							if (src) paths.push(resolve(dirname(configured), src.replace(/^\//, "")));
						}
						if (!paths.length) fail("missing_roots", htmlPath, "no module script entry");
					} else paths.push(configured);
					for (const path of paths) {
						if (!files.some((row) => resolve(root, row.path) === path && eligible(row))) fail("root_classification", relative(root, path), "application entry absent from inventory");
						entries.set(path, invocation);
					}
				});
			}
		}
	}
}
class Provenance {
	readonly checker: ts.TypeChecker;
	readonly sourceFiles: ts.SourceFile[];
	readonly reachable = new Map<ts.Node, { root: Locus; chain: Locus[] }>();
	readonly calls: ts.CallExpression[] = [];
	readonly errors: Problem[] = [];
	readonly aliases: Locus[] = [];
	readonly assets: { path: string; sha256: string }[] = [];
	private readonly links = new Map<ts.Node, { target: ts.Node; site: ts.Node }[]>();
	private readonly points = new Map<ts.Node, Set<ts.Node>>();
	private readonly transfers = new Map<ts.Node, Set<ts.Node>>();
	private readonly watchers = new Map<ts.Node, Set<() => void>>();
	private readonly queue: (() => void)[] = [];
	private readonly returns = new Map<ts.Node, ts.Node[]>();

	private readonly scopeWatchers = new Map<ts.Node, (() => void)[]>();
	private readonly receivers = new Map<ts.Node, ts.Node[]>();
	readonly registeredCallbacks = new Set<ts.Node>();
	private readonly schemaCallbacks = new Map<ts.Node, Set<ts.Node>>();
	private readonly nativeWatches = new Map<ts.Node, Set<ts.Node>>();
	private readonly eventRegistrations = new Map<ts.CallExpression, ts.Expression>();
	private readonly eventEmissions = new Map<ts.CallExpression, ts.Expression>();
	private readonly emittedRegistrations = new Set<ts.CallExpression>();
	private nativeReady = false;
	private readonly callbackTargets = new Map<ts.Node, Set<ts.Node>>();
	private readonly invocationSites = new Map<ts.Node, Map<ts.CallExpression | ts.NewExpression, { arguments: readonly ts.Expression[]; synchronous: boolean }>>();
	readonly externalEvents = new Map<ts.CallExpression, { source: Locus; events: string[]; declaration: Locus; declarationSha256: string; documentation: string }>();
	readonly targets = new Map<ts.CallExpression, Set<ts.Node>>();
	readonly moduleCalls = new Set<ts.CallExpression>();
	readonly dependencyContracts = new Map<string, { version: string; sha256: string; operations: Locus[] }>();
	constructor(readonly root: string, readonly program: ts.Program, readonly files: Entry[], readonly roots: Map<string, Locus>, qualityOnly = false) {
		this.checker = program.getTypeChecker();
		this.sourceFiles = files.filter((row) => eligible(row) && (!qualityOnly || qualitySource(row.path))).map((row) => program.getSourceFile(resolve(root, row.path))).flatMap((file) => file ? [file] : []);
		for (const file of this.sourceFiles) {
			const invocation = roots.get(resolve(file.fileName));
			if (invocation) this.reachable.set(file, { root: invocation, chain: [] });
			walk(file, (node) => this.linkNode(node));
		}
		for (const file of this.sourceFiles) walk(file, (node) => this.flowNode(node));
		for (const [node, path] of this.reachable) this.activate(node, path);
		for (let index = 0; index < this.queue.length; index++) this.queue[index]?.();
		this.queue.length = 0;
		this.nativeReady = true;
		this.dispatchEvents();
		for (let index = 0; index < this.queue.length; index++) this.queue[index]?.();
		this.queue.length = 0;
		this.validateEventRegistrations();
	}
	private validateEventRegistrations() {
		const validateRegistration = ([call, receiver]: [ts.CallExpression, ts.Expression]): void => {
			if (!this.path(call)) return;
			const values = this.runtimeValues(receiver, new Map<ts.ParameterDeclaration, ts.Expression>());
			const local = values.some((value) => ts.isNewExpression(value) && (/@types\/node\/events\.d\.ts$/.test(this.nativeOwner(value)) || memberName(value.expression) === "AbortController"));
			const native = this.nativeEventContract(receiver, call);
			if (!local && !native && !this.externalEventOrigin(receiver) && !this.externalEvents.has(call)) this.problem(call, "unresolved_event_source", receiver);
			const names = call.arguments[0] ? this.strings(call.arguments[0]).map((row) => row.value) : [];
			if (!names.length) this.problem(call, "dynamic_event_trigger");
			if (native && names.some((name) => native.declared.has(name) && !native.events.has(name)) && !this.externalEvents.has(call) && !this.emittedRegistrations.has(call)) this.problem(call, "unsupported_native_event_lifecycle", receiver);
			for (const [emission, emittedReceiver] of this.eventEmissions) {
				const emittedNames = emission.arguments[0] ? this.strings(emission.arguments[0]).map((row) => row.value) : [];
				if (!emittedNames.length && memberName(emission.expression) !== "abort" && this.runtimeValues(emittedReceiver, new Map<ts.ParameterDeclaration, ts.Expression>()).some((value) => values.includes(value))) this.problem(emission, "dynamic_event_trigger");
				if (emittedNames.some((name) => names.includes(name)) && this.runtimeValues(emittedReceiver, new Map<ts.ParameterDeclaration, ts.Expression>()).some((value) => values.includes(value)) && !this.eventContexts(call).some((before) => this.eventContexts(emission).some((after) => before.sites[0] === after.sites[0]))) this.problem(call, "unresolved_event_order", emission);
			}

		};
		for (const [call, receiver] of this.eventRegistrations) validateRegistration([call, receiver]);
	}

	nativeOwner(call: ts.CallExpression | ts.NewExpression): string {
		return this.checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName ?? this.declaration(call.expression)?.getSourceFile().fileName ?? "";
	}
	locus(node: ts.Node, symbol = node.getText().slice(0, 160)): Locus {
		const source = node.getSourceFile();
		return { path: relative(this.root, source.fileName), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, symbol };
	}
	problem(node: ts.Node, code: string, value?: ts.Node): void { this.errors.push({ ...this.locus(node), code, ...(ts.isCallExpression(node) ? { declarationOwner: this.nativeOwner(node) } : {}), ...(value ? { valueOrigins: [...this.points.get(value) ?? []].map((node) => this.locus(node)) } : {}) }); }
	declaration(node: ts.Node): ts.Declaration | undefined {
		const unwrapped = unwrap(node);
		const symbol = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name : unwrapped);
		if (!symbol) return undefined;
		const target = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
		return target.valueDeclaration ?? target.declarations?.[0] ?? symbol.declarations?.[0];
	}
	resolve(input: ts.Node, seen = new Set<ts.Node>()): ts.Node | undefined {
		const node = unwrap(input);
		if (seen.has(node)) return undefined;
		seen.add(node);
		if (isFunction(node) || ts.isObjectLiteralExpression(node) || ts.isStringLiteralLike(node) || ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isArrayLiteralExpression(node) || ts.isTemplateExpression(node) || ts.isTaggedTemplateExpression(node)) return node;
		const decl = this.declaration(node);
		if (!decl) return undefined;
		if ((ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) && decl.initializer) return this.resolve(decl.initializer, seen);
		return this.resolveBinding(decl, seen);
	}
	private resolveBinding(decl: ts.Declaration, seen: Set<ts.Node>): ts.Node | undefined {
		if (ts.isBindingElement(decl)) {
			const owner = decl.parent.parent;
			if (ts.isVariableDeclaration(owner) && owner.initializer) {
				const value = this.resolve(owner.initializer, seen);
				if (value && ts.isObjectLiteralExpression(value)) {
					const name = (decl.propertyName ?? decl.name).getText();
					const property = value.properties.find((item) => item.name?.getText() === name);
					if (property && ts.isPropertyAssignment(property)) return this.resolve(property.initializer, seen);
				}
				const type = this.checker.getTypeAtLocation(owner.initializer);
				const property = type.getProperty((decl.propertyName ?? decl.name).getText());
				const target = property?.valueDeclaration;
				if (target) return target;
			}
		}
		return decl;
	}
	callTarget(call: ts.CallExpression): ts.Node | undefined {
		const bound = this.targets.get(call);
		if (bound?.size === 1) return [...bound][0];
		const target = this.resolve(call.expression);
		if (target && ts.isCallExpression(target) && memberName(target.expression) === "bind" && ts.isPropertyAccessExpression(target.expression)) {
			if (target.arguments.length > 1) { this.problem(call, "unsupported_bound_arguments"); return undefined; }
			return this.resolve(target.expression.expression);
		}
		return target;
	}
	private add(from: ts.Node, target: ts.Node, site: ts.Node): void {
		if (!this.sourceFiles.includes(target.getSourceFile())) return;
		const values = this.links.get(from) ?? []; values.push({ target, site }); this.links.set(from, values);
	}
	private linkNode(node: ts.Node): void {
		const linkModuleDeclaration = (): void => {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
				const module = node.moduleSpecifier;
				if (!module) return;
				const symbol = this.checker.getSymbolAtLocation(module);
				const target = symbol?.declarations?.[0];
				if (target && ts.isSourceFile(target)) this.add(node.getSourceFile(), target, node);
				else if (ts.isStringLiteral(module) && module.text.startsWith(".")) {
					if (module.text.endsWith(".css") && ts.isImportDeclaration(node) && !node.importClause) {
						const path = relative(this.root, resolve(dirname(node.getSourceFile().fileName), module.text));
						this.assets.push({ path, sha256: digest(readFileSync(sourcePath(this.root, path))) });
					} else this.problem(module, "unresolved_import");
				}
			}
		};
		linkModuleDeclaration();
		if (ts.isVariableDeclaration(node) && node.initializer && [ts.SyntaxKind.Identifier, ts.SyntaxKind.PropertyAccessExpression].includes(unwrap(node.initializer).kind)) this.aliases.push(this.locus(node));
		if (!ts.isCallExpression(node)) return;
		this.calls.push(node);
		if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = node.arguments[0];
			const names = argument ? this.moduleNames(argument) : [];
			for (const name of names) this.linkDynamicModule(node, name);
		}
	}
	private linkDynamicModule(node: ts.CallExpression, name: string): void {
		if (!name.startsWith(".") && !name.startsWith("/")) {
			const workspace = knipWorkspaces().find((row) => row.packageName === name);
			if (workspace) {
				const source = this.program.getSourceFile(join(this.root, workspace.dir, "src/index.ts"));
				if (source) { this.add(scope(node), source, node); this.point(node, source); }
			}
			this.moduleCalls.add(node); return;
		}
		const absolute = name.startsWith("/") && !name.startsWith(this.root) ? resolve(this.root, name.slice(1)) : resolve(dirname(node.getSourceFile().fileName), name);
		const source = this.program.getSourceFile(absolute) ?? this.program.getSourceFile(absolute.replace(/\.js$/, ".ts")) ?? this.program.getSourceFile(`${absolute}.ts`) ?? this.program.getSourceFile(`${absolute}/index.ts`);
		if (source) { this.add(scope(node), source, node); this.point(node, source); this.moduleCalls.add(node); }
		else if (name.endsWith(".json")) {
			const path = relative(this.root, absolute);
			this.assets.push({ path, sha256: digest(readFileSync(sourcePath(this.root, path))) }); this.moduleCalls.add(node);
		}
	}
	private moduleNames(argument: ts.Expression): string[] {
		if (ts.isStringLiteralLike(argument)) return [argument.text];
		const resolved = this.resolve(argument);
		if (resolved && ts.isCallExpression(resolved) && memberName(resolved.expression) === "resolveSync" && /bun-types\//.test(this.nativeOwner(resolved))) {
			const name = resolved.arguments[0]; return name ? this.values(name).map((row) => row.value) : [];
		}
		const concrete = this.strings(argument, true);
		if (concrete.length && concrete.every((row) => !/[?*{]/.test(row.value))) return concrete.map((row) => row.value.startsWith(".") || isAbsolute(row.value) ? row.value : `/${row.value}`);
		return this.globModuleNames(argument);
	}
	private globModuleNames(argument: ts.Expression): string[] {
		if (!ts.isTemplateExpression(argument) || argument.templateSpans.length !== 1) return [];
		const span = argument.templateSpans[0];
		if (span?.literal.text !== "") return [];
		const declaration = this.declaration(span.expression);
		if (!declaration || !ts.isVariableDeclarationList(declaration.parent) || !ts.isForOfStatement(declaration.parent.parent)) return [];
		const iterable = declaration.parent.parent.expression;
		if (!ts.isCallExpression(iterable) || !ts.isPropertyAccessExpression(iterable.expression) || memberName(iterable.expression) !== "scan") return [];
		const glob = this.declaration(iterable.expression.expression);
		if (!glob || !ts.isVariableDeclaration(glob) || !glob.initializer || !ts.isNewExpression(glob.initializer)) return [];
		const pattern = glob.initializer.arguments?.[0];
		const declarationOwner = this.declaration(glob.initializer.expression);
		if (!pattern || !declarationOwner?.getSourceFile().fileName.includes("bun-types")) return [];
		return this.values(pattern).flatMap((row) => {
			const matcher = new Bun.Glob(row.value);
			return this.files.filter((file) => eligible(file) && matcher.match(file.path)).map((file) => `${argument.head.text}${file.path}`);
		});
	}
	private point(node: ts.Node, value: ts.Node): void {
		const values = this.points.get(node) ?? new Set<ts.Node>();
		if (values.has(value)) return;
		values.add(value); this.points.set(node, values);
		for (const target of this.transfers.get(node) ?? []) this.queue.push(() => this.point(target, value));
		for (const watch of this.watchers.get(node) ?? []) this.queue.push(watch);
	}
	private flow(from: ts.Node, to: ts.Node): void {
		const targets = this.transfers.get(from) ?? new Set<ts.Node>();
		if (targets.has(to)) return;
		targets.add(to); this.transfers.set(from, targets);
		for (const value of this.points.get(from) ?? []) this.point(to, value);
	}
	private watch(node: ts.Node, operation: () => void): void {
		const watchers = this.watchers.get(node) ?? new Set<() => void>();
		watchers.add(operation); this.watchers.set(node, watchers); this.queue.push(operation);
	}
	private activate(node: ts.Node, path: { root: Locus; chain: Locus[] }): void {
		this.reachable.set(node, path);
		for (const watch of this.scopeWatchers.get(node) ?? []) this.queue.push(watch);
		for (const link of this.links.get(node) ?? []) {
			if (!this.reachable.has(link.target)) this.activate(link.target, { root: path.root, chain: [...path.chain, this.locus(link.site)] });
		}
	}
	private missingOptionalReceiver(node: ts.Node): boolean {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.questionDotToken) {
			const receiver = node.expression.expression;
			if (ts.isPropertyAccessExpression(receiver)) {
				const values = [...this.points.get(receiver.expression) ?? []];
				if (values.length && values.every((value) => ts.isObjectLiteralExpression(value) && value.properties.every((property) => !ts.isSpreadAssignment(property) && property.name && memberName(property.name) !== receiver.name.text))) return true;
			}
		}
		return false;
	}
	private activeBranch(node: ts.Node): boolean {
		if (this.missingOptionalReceiver(node)) return false;
		let child = node;
		for (let parent = node.parent; parent && !isFunction(parent); child = parent, parent = parent.parent) {
			if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
				const index = parent.statements.findIndex((statement) => statement === child);
				if (index > 0 && parent.statements.slice(0, index).some((statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement))) return false;
			}
			if (!this.activeConditional(parent, child, node)) return false;
		}
		return true;
	}
	private activeConditional(parent: ts.Node, child: ts.Node, node: ts.Node): boolean {
		if (!ts.isIfStatement(parent)) return true;
		const expression = unwrap(parent.expression);
		if (expression.kind === ts.SyntaxKind.FalseKeyword && child === parent.thenStatement || expression.kind === ts.SyntaxKind.TrueKeyword && child === parent.elseStatement) return false;
		if (expression.getText() === "import.meta.main" && !this.roots.has(resolve(node.getSourceFile().fileName)) && child === parent.thenStatement) return false;
		return !this.testOnlyFlag(expression) || child !== parent.thenStatement;
	}
	private testOnlyFlag(expression: ts.Node): boolean {
		if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) || memberName(expression.expression) !== "has") return false;
		const flag = expression.arguments[0];
		const receiver = this.declaration(expression.expression.expression);
		if (!flag || !ts.isStringLiteral(flag) || !/^--(?:self-test(?:-[\w-]+)?|update|fixture)$/.test(flag.text) || !receiver || !ts.isVariableDeclaration(receiver) || !receiver.initializer || !ts.isNewExpression(receiver.initializer)) return false;
		if (receiver.initializer.expression.getText() !== "Set" || !receiver.initializer.arguments?.some((argument) => argument.getText().includes("process.argv"))) return false;
		return true;
	}

	private inScope(node: ts.Node, operation: () => void): void {
		const owner = scope(node), watchers = this.scopeWatchers.get(owner) ?? [];
		const execute = () => { if (this.activeBranch(node)) operation(); };
		watchers.push(execute); this.scopeWatchers.set(owner, watchers);
		if (this.reachable.has(owner)) this.queue.push(execute);
	}
	private property(base: ts.Node, key: string, result: ts.Node): void {
		this.watch(base, () => {
			for (const value of this.points.get(base) ?? []) this.flowPropertyValue(value, key, result);
		});
	}
	private flowPropertyValue(value: ts.Node, key: string, result: ts.Node): void {
		if (ts.isObjectLiteralExpression(value)) { this.flowObjectProperties(value, key, result); return; }
		if (ts.isArrayLiteralExpression(value) && /^\d+$/.test(key)) {
			const element = value.elements[Number(key)]; if (element) this.flow(element, result);
		}
		if (ts.isSourceFile(value) || ts.isModuleDeclaration(value)) {
			const module = this.checker.getSymbolAtLocation(ts.isModuleDeclaration(value) ? value.name : value);
			const symbol = module && this.checker.getExportsOfModule(module).find((row) => row.name === key);
			const declaration = symbol?.valueDeclaration;
			if (declaration) this.flow(declaration, result);
		}
		if (ts.isNewExpression(value)) this.flowConstructedProperty(value, key, result);
	}
	private flowObjectProperties(value: ts.ObjectLiteralExpression, key: string, result: ts.Node): void {
			for (const property of value.properties) {
				if (ts.isSpreadAssignment(property)) { this.propertyOnce(property.expression, key, result); continue; }
				if (property.name && memberName(property.name) === key) this.flow(property, result);
			}
		
	}
	private flowConstructedProperty(value: ts.NewExpression, key: string, result: ts.Node): void {
			const declaration = this.declaration(value.expression);
			if (declaration && ts.isClassDeclaration(declaration)) {
				for (const member of declaration.members) if (member.name && memberName(member.name) === key) this.flow(member, result);
			}
		
	}

	private readonly propertyLinks = new Map<ts.Node, Map<string, Set<ts.Node>>>();
	private propertyOnce(base: ts.Node, key: string, result: ts.Node): void {
		const keys = this.propertyLinks.get(base) ?? new Map<string, Set<ts.Node>>();
		this.propertyLinks.set(base, keys);
		const targets = keys.get(key) ?? new Set<ts.Node>(); keys.set(key, targets);
		if (targets.has(result)) return;
		targets.add(result); this.property(base, key, result);
	}
	private invoke(call: ts.CallExpression | ts.NewExpression, target: ts.Node, arguments_: readonly ts.Expression[], direct = true): void {
		const path = this.path(call);
		if (!path || !isFunction(target) || !this.sourceFiles.includes(target.getSourceFile())) return;
		this.recordInvocation(call, target, direct, arguments_);
		if (!this.reachable.has(target)) this.activate(target, { root: path.root, chain: [...path.chain, this.locus(call)] });
		this.flowInvocationArguments(target, arguments_);
		for (const receiver of this.receivers.get(target) ?? []) {
			if (ts.isNewExpression(call)) this.flow(call, receiver);
			else if (ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)) this.flow(call.expression.expression, receiver);
		}
		for (const expression of this.returns.get(target) ?? []) this.flow(expression, call);
	}
	private flowInvocationArguments(target: ts.SignatureDeclaration, arguments_: readonly ts.Expression[]) {
		for (let index = 0; index < target.parameters.length; index++) {
			const parameter = target.parameters[index], argument = arguments_[index];
			if (parameter && argument) this.flow(argument, parameter);
			else if (parameter?.initializer) this.flow(parameter.initializer, parameter);
		}
	}

	private recordInvocation(call: ts.CallExpression | ts.NewExpression, target: ts.SignatureDeclaration, direct: boolean, arguments_: readonly ts.Expression[]) {
		const callbacks = this.callbackTargets.get(call) ?? new Set<ts.Node>(); callbacks.add(target); this.callbackTargets.set(call, callbacks);
		if (direct && ts.isCallExpression(call)) {
			const targets = this.targets.get(call) ?? new Set<ts.Node>(); targets.add(target); this.targets.set(call, targets);
		}
		const sites = this.invocationSites.get(target) ?? new Map<ts.CallExpression | ts.NewExpression, { arguments: readonly ts.Expression[]; synchronous: boolean; }>();
		if (!sites.has(call)) {
			const owner = this.nativeOwner(call), name = memberName(call.expression);
			const synchronous = direct || (ts.isCallExpression(call) && this.eventEmissions.has(call)) || /typescript\/lib\//.test(owner) && !["then", "catch", "finally"].includes(name) || /async_hooks\.d\.ts$/.test(owner);
			sites.set(call, { arguments: arguments_, synchronous }); this.invocationSites.set(target, sites);
			this.queue.push(() => this.dispatchEvents());
		}
	}

	private externalEventOrigin(receiver: ts.Node, seen = new Set<ts.Node>()): ts.CallExpression | ts.NewExpression | undefined {
		if (seen.has(receiver)) return undefined;
		seen.add(receiver);
		const value = this.resolve(receiver);
		if (value && ts.isNewExpression(value) && /\/net\.d\.ts$/.test(this.nativeOwner(value))) {
			const origins = this.runtimeValues(receiver, new Map<ts.ParameterDeclaration, ts.Expression>());
			const connect = this.calls.find((call) => this.path(call) && ts.isPropertyAccessExpression(call.expression) && memberName(call.expression) === "connect" && /\/net\.d\.ts$/.test(this.nativeOwner(call)) && this.runtimeValues(call.expression.expression, new Map<ts.ParameterDeclaration, ts.Expression>()).some((origin) => origins.includes(origin)));
			if (connect) return connect;
		}
		if (value && (ts.isCallExpression(value) || ts.isNewExpression(value)) && this.path(value)) {
			const owner = this.nativeOwner(value), name = memberName(value.expression);
			if (/\/(?:net|child_process|readline)\.d\.ts$/.test(owner) && ["connect", "createConnection", "spawn", "spawnSync", "execFile", "fork", "createInterface"].includes(name)) return value;
			if (/lib\.dom\.d\.ts$|bun-types\//.test(owner) && ["WebSocket", "EventSource"].includes(name)) return value;
		}
		for (const value of this.points.get(receiver) ?? []) {
			if (value === receiver) continue;
			const origin = this.externalEventOrigin(value, seen);
			if (origin) return origin;
		}
		return undefined;
	}
	// Expand existing invocation edges, retaining call-site identity rather than
	// comparing lexical function positions or the queue's discovery order.
	private eventContexts(node: ts.Node, seen = new Set<ts.Node>()): EventContext[] {
		const owner = scope(node);
		if (seen.has(owner) || !this.path(node)) return [];
		// Runtime branches/loops and a resumed async segment do not have a proven
		// order relative to another invocation. Preserve that uncertainty as exit 2.
		for (let parent = node.parent; parent && parent !== owner; parent = parent.parent) {
			if (ts.isIfStatement(parent) && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(unwrap(parent.expression).kind) || ts.isConditionalExpression(parent) || ts.isIterationStatement(parent, false)) return [];
		}
		let resumed = false;
		walk(owner, (part) => { if (ts.isAwaitExpression(part) && scope(part) === owner && part.getEnd() < node.getStart()) resumed = true; });
		if (resumed) return [];
		seen.add(owner);
		if (ts.isSourceFile(owner)) {
			if (this.roots.has(resolve(owner.fileName))) return [{ sites: [owner, node], bindings: new Map<ts.ParameterDeclaration, ts.Expression>() }];
			return [...this.links].flatMap(([, links]) => links.filter((link) => link.target === owner).flatMap((link) => this.eventContexts(link.site, new Set(seen)).map((context) => ({ ...context, sites: [...context.sites, node] }))));
		}
		return [...this.invocationSites.get(owner) ?? []].flatMap(([call, invocation]) => {
			if (!isFunction(owner)) return [];
			// A callback's own synchronous segment has an order even when its relation
			// to the registering stack is unknown (Promise/event-loop delivery).
			const contexts = invocation.synchronous ? this.eventContexts(call, new Set(seen)) : [{ sites: [owner], bindings: new Map<ts.ParameterDeclaration, ts.Expression>() }];
			return contexts.map((context) => {
				const bindings = new Map(context.bindings);
				for (let index = 0; index < owner.parameters.length; index++) {
					const parameter = owner.parameters[index], argument = invocation.arguments[index];
					if (parameter && argument) bindings.set(parameter, argument);
				}
				return { sites: [...context.sites, node], bindings };
			});
		});
	}
	private eventOrder(before: EventContext, after: EventContext): boolean {
		if (before.sites[0] !== after.sites[0]) return false;
		for (let index = 0; index < Math.min(before.sites.length, after.sites.length); index++) {
			const left = before.sites[index], right = after.sites[index];
			if (!left || !right) return false;
			if (left === right) continue;
			return scope(left) === scope(right) && left.getEnd() < right.getEnd();
		}
		return false;
	}
	private nativeEventContract(receiver: ts.Node, registration?: ts.CallExpression) {
		const symbol = this.checker.getTypeAtLocation(receiver).getSymbol();
		const declaration = symbol?.declarations?.find((node) => symbol.name === "Process" && /@types\/node\/process\.d\.ts$/.test(node.getSourceFile().fileName) || symbol.name === "App" && /electron\/electron\.d\.ts$/.test(node.getSourceFile().fileName));
		if (!declaration) return undefined;
		const source = declaration.getSourceFile(), declared = new Set<string>();
		walk(declaration, (node) => {
			if (ts.isMethodSignature(node) && memberName(node.name) === "on") {
				const event = node.parameters[0]?.type;
				if (event && ts.isLiteralTypeNode(event) && ts.isStringLiteral(event.literal)) declared.add(event.literal.text);
			}
		});
		const events = new Set<string>();
		if (symbol?.name === "Process") {
			// Node's documented signal events, restricted to catchable host signals.
			// A private EventEmitter name is not an operating-system signal.
			walk(source, (node) => {
				if (!ts.isTypeAliasDeclaration(node) || node.name.text !== "Signals") return;
				walk(node.type, (part) => {
					if (ts.isStringLiteral(part)) {
						declared.add(part.text);
						if (Object.hasOwn(constants.signals, part.text) && !["SIGKILL", "SIGSTOP"].includes(part.text)) events.add(part.text);
					}
				});
			});
			events.add("exit"); events.add("beforeExit");
		} else {
			// These recurring desktop events have OS/window-manager producers.
			// Other App events need their own lifecycle prerequisite, not type credit.
			const electronRoot = [...this.roots.values()].some((root) => root.symbol === "electron-vite" || root.path.endsWith("electron.vite.config.ts"));
			if (electronRoot) {
				events.add("activate");
				// Electron emits ready after the main module's synchronous startup.
				// A listener installed by a ready Promise continuation is already late.
				if (registration && this.eventContexts(registration).some((context) => context.sites[0] && ts.isSourceFile(context.sites[0]))) events.add("ready");
				const window = this.sourceFiles.some((file) => {
					let created = false;
					walk(file, (node) => { if (ts.isNewExpression(node) && memberName(node.expression) === "BrowserWindow" && /electron\/electron\.d\.ts$/.test(this.nativeOwner(node)) && this.path(node)) created = true; });
					return created;
				});
				if (window) events.add("window-all-closed");
			}
		}
		return { declaration, declared, events, documentation: symbol?.name === "Process" ? "https://nodejs.org/api/process.html#signal-events;#event-exit;#event-beforeexit" : "https://www.electronjs.org/docs/latest/api/app#event-activate;#event-ready;#event-window-all-closed" };
	}
	private dispatchEvents(): void {
		for (const [registration, receiver] of this.eventRegistrations) this.dispatchRegistration(registration, receiver);
	}
	private dispatchRegistration(registration: ts.CallExpression, receiver: ts.Expression): void {
			const callback = registration.arguments[1];
			if (!callback) return;
			const names = registration.arguments[0] ? this.strings(registration.arguments[0]).map((row) => row.value) : [];
			const origins = this.runtimeValues(receiver, new Map<ts.ParameterDeclaration, ts.Expression>());
			for (const [emission, emittedReceiver] of this.eventEmissions) this.dispatchEmission(registration, receiver, callback, names, origins, emission, emittedReceiver);
			this.dispatchExternal(registration, receiver, callback, names, origins);
	}
	private dispatchEmission(registration: ts.CallExpression, receiver: ts.Expression, callback: ts.Expression, names: string[], origins: ts.Node[], emission: ts.CallExpression, emittedReceiver: ts.Expression): void {
				const ordered = this.eventContexts(registration).flatMap((before) => this.eventContexts(emission).filter((after) => {
					if (!this.eventOrder(before, after) || !this.runtimeValues(emittedReceiver, after.bindings).some((value) => this.runtimeValues(receiver, before.bindings).includes(value))) return false;
					const registered = registration.arguments[0] ? this.strings(registration.arguments[0], false, new Set<ts.Node>(), before.bindings).map((row) => row.value) : [];
					const emitted = memberName(emission.expression) === "abort" ? ["abort"] : emission.arguments[0] ? this.strings(emission.arguments[0], false, new Set<ts.Node>(), after.bindings).map((row) => row.value) : [];
					return emitted.some((name) => registered.includes(name));
				}).map((after) => ({ before, after })));
				if (!ordered.length) return;
				const emittedNames = memberName(emission.expression) === "abort" ? ["abort"] : emission.arguments[0] ? this.strings(emission.arguments[0]).map((row) => row.value) : [];
				if (!emittedNames.some((name) => names.includes(name))) return;
				const removed = this.calls.some((call) => {
					if (!this.path(call) || !ordered.every(({ before, after }) => this.eventContexts(call).some((context) => this.eventOrder(before, context) && this.eventOrder(context, after)))) return false;
					if (!ts.isPropertyAccessExpression(call.expression) || !["off", "removeListener", "removeAllListeners", "removeEventListener"].includes(memberName(call.expression)) || !/@types\/node\/|lib\.dom\.d\.ts$/.test(this.nativeOwner(call))) return false;
					if (!this.runtimeValues(call.expression.expression, new Map<ts.ParameterDeclaration, ts.Expression>()).some((value) => origins.includes(value))) return false;
					const event = call.arguments[0], handler = call.arguments[1];
					if (event && !this.strings(event).some((row) => names.includes(row.value))) return false;
					return memberName(call.expression) === "removeAllListeners" || !!handler && this.runtimeValues(handler, new Map<ts.ParameterDeclaration, ts.Expression>()).some((value) => this.runtimeValues(callback, new Map<ts.ParameterDeclaration, ts.Expression>()).includes(value));
				});
				if (removed) return;
				this.emittedRegistrations.add(registration);
				for (const { before, after } of ordered) for (const target of this.runtimeValues(callback, before.bindings)) {
					const root = after.sites[0], path = this.path(emission);
					if (root && ts.isSourceFile(root) && path && implementation(target) && !this.reachable.has(target)) this.activate(target, { root: path.root, chain: after.sites.slice(1).map((site) => this.locus(site)) });
					this.invoke(emission, target, emission.arguments.slice(1), false);
				}
	}
	private dispatchExternal(registration: ts.CallExpression, receiver: ts.Expression, callback: ts.Expression, names: string[], origins: ts.Node[]): void {

			const origin = this.externalEventOrigin(receiver);
			if (origin) for (const target of this.points.get(callback) ?? []) this.invoke(origin, target, [], false);
			const contract = this.nativeEventContract(receiver, registration);
			const nativeNames = names.filter((name) => {
				if (!contract?.events.has(name)) return false;
				const contexts = this.eventContexts(registration);
				const removals = this.calls.filter((call) => {
					if (!this.path(call) || !ts.isPropertyAccessExpression(call.expression) || !["off", "removeListener", "removeAllListeners", "removeEventListener"].includes(memberName(call.expression))) return false;
					if (!/@types\/node\/|lib\.dom\.d\.ts$/.test(this.nativeOwner(call))) return false;
					return this.runtimeValues(call.expression.expression, new Map<ts.ParameterDeclaration, ts.Expression>()).some((value) => origins.includes(value));
				});
				return !contexts.length || !contexts.every((before) => removals.some((call) => this.eventContexts(call).some((after) => {
					if (!this.eventOrder(before, after)) return false;
					const event = call.arguments[0], handler = call.arguments[1];
					if (event && !this.strings(event, false, new Set<ts.Node>(), after.bindings).some((row) => row.value === name)) return false;
					return memberName(call.expression) === "removeAllListeners" || !!handler && this.runtimeValues(handler, after.bindings).some((value) => this.runtimeValues(callback, before.bindings).includes(value));
				})));
			});
			if (this.nativeReady && contract && nativeNames.length) {
				const path = this.path(registration);
				if (!path) return;
				const declaration = this.locus(contract.declaration);
				const source = { ...declaration, symbol: `native lifecycle event: ${nativeNames.join(",")}` };
				this.externalEvents.set(registration, { source, events: nativeNames, declaration, declarationSha256: digest(readFileSync(contract.declaration.getSourceFile().fileName)), documentation: contract.documentation });
				for (const target of this.points.get(callback) ?? []) {
					if (!this.reachable.has(target)) this.activate(target, { root: path.root, chain: [...path.chain, source, this.locus(registration)] });
					this.invoke(registration, target, [], false);
				}
			}
	}

	invokedWithin(owner: ts.Node): ts.Node[] {
		return [...this.callbackTargets].filter(([call]) => scope(call) === owner && this.path(call)).flatMap(([, targets]) => [...targets]);
	}
	private flowNode(node: ts.Node): void {
		const plain = unwrap(node);
		if (plain !== node) { this.flow(plain, node); return; }
		if (isFunction(node) || ts.isObjectLiteralExpression(node) || ts.isNewExpression(node) || ts.isStringLiteralLike(node) || ts.isArrayLiteralExpression(node) || ts.isModuleDeclaration(node)) this.point(node, node);
		this.flowBindings(node);
		this.flowMember(node);
		this.flowExpressions(node);
		if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
		const arguments_ = node.arguments ?? [];
		const execute = () => {
			if (!this.path(node) || !this.activeBranch(node)) return;
			this.invokeSourceTargets(node, arguments_);
			// Native callback contracts are resolved by their declaration owner, not
			// the spelling of an arbitrary user-defined method.
			const file = this.callbackOwner(node), name = memberName(node.expression);
			const immediate = /typescript\/lib\/lib\..*\.d\.ts$/.test(file) && ["map", "flatMap", "filter", "forEach", "some", "every", "find", "findIndex", "reduce", "reduceRight", "sort", "from", "then", "catch", "finally", "replace", "replaceAll"].includes(name);
			const scheduled = /(?:(?:bun-types|@types\/node)\/|typescript\/lib\/lib\..*\.d\.ts$)/.test(file) && ["queueMicrotask", "setTimeout", "setInterval", "setImmediate"].includes(name);
			const eventCallback = /(?:@types\/node\/|electron\/electron\.d\.ts$|typescript\/lib\/lib\.dom\.d\.ts$|bun-types\/)/.test(file) && ["on", "once", "addListener", "addEventListener"].includes(name);
			this.invokeElectronHandler(name, file, arguments_);
			if (/\/node_modules\//.test(file) && ["removeEventListener", "removeListener", "off", "assign"].includes(name)) for (const argument of arguments_) this.registeredCallbacks.add(argument);
			const receiver = ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression) ? node.expression.expression : undefined;
			this.flowComposedAbort(node, receiver, name, file, arguments_);
			this.activateSpawnedSource(node, file, name, arguments_);
			this.invokeModuleFactory(node, receiver, name, arguments_);
			this.recordNativeEvents(node, receiver, eventCallback, arguments_, name, file);
			this.invokeNativeCallbacks(immediate, scheduled, arguments_, node, receiver);
			this.invokeAiCallbacks(file, name, node, execute, arguments_);
			if (/bun-types\//.test(file) && ["scan", "scanSync"].includes(name)) this.point(node, node);
			this.invokeBunCallbacks(file, name, arguments_, node);
			this.flowNativeContainers(receiver, name, file, node, arguments_);
			this.flowAsyncStorage(receiver, file, name, arguments_, node);
			if (/\/drizzle-orm\//.test(file) && name === "sqliteTable") for (const argument of arguments_) this.registeredCallbacks.add(argument);
			this.flowSchemaCallbacks(file, node, arguments_, receiver, name);
			this.flowMapEntries(file, name, arguments_, node, receiver);
			this.flowCollectionConstructor(node, file, name, arguments_);
			const invokePromiseExecutor = (): void => {
				if (ts.isNewExpression(node) && /typescript\/lib\/lib\.es2015\.promise\.d\.ts$/.test(file)) {
					const callback = arguments_[0];
					if (callback) for (const target of this.points.get(callback) ?? []) this.invoke(node, target, [], false);
				}
			};
			invokePromiseExecutor();
		};
		this.inScope(node, execute); this.watch(node.expression, execute);
		if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) this.watch(node.expression.expression, execute);
		for (const argument of arguments_) this.watch(argument, execute);
	}
	private callbackOwner(node: ts.CallExpression | ts.NewExpression): string {
		let file = this.nativeOwner(node);
		if (!file && ts.isPropertyAccessExpression(node.expression)) {
			const base = this.resolve(node.expression.expression);
			if (base && ts.isCallExpression(base) && memberName(base.expression) === "split" && /typescript\/lib\//.test(this.nativeOwner(base))) file = this.nativeOwner(base);
		}
		return file;
	}
	private flowMapEntries(file: string, name: string, arguments_: ts.NodeArray<ts.Expression> | never[], node: ts.NewExpression | ts.CallExpression, receiver: ts.LeftHandSideExpression | undefined) {
		if (/typescript\/lib\/lib\..*\.d\.ts$/.test(file) && name === "assign") {
			for (const argument of arguments_) this.flow(argument, node);
		}
		const flowMapOperation = (): void => {
			if (!/typescript\/lib\/lib\..*\.d\.ts$/.test(file) || !receiver || !["get", "set", "add", "values", "entries"].includes(name)) return;
				if (name === "set" || name === "add") {
					const value = arguments_[name === "set" ? 1 : 0];
					const declaration = this.declaration(receiver);
					if (value && declaration) this.flow(value, declaration);
					if (value) for (const container of this.points.get(receiver) ?? []) if (ts.isNewExpression(container)) this.flow(value, container);
					for (const argument of arguments_) this.registeredCallbacks.add(argument);
				} else this.flow(receiver, node);
		};
		flowMapOperation();

	}

	private flowNativeContainers(receiver: ts.LeftHandSideExpression | undefined, name: string, file: string, node: ts.NewExpression | ts.CallExpression, arguments_: ts.NodeArray<ts.Expression> | never[]) {
		if (receiver && name === "split" && /typescript\/lib\//.test(file)) this.flow(receiver, node);
		if (receiver && /typescript\/lib\/lib\..*\.d\.ts$/.test(file) && ["push", "unshift"].includes(name)) {
			const declaration = this.declaration(receiver);
			if (declaration) for (const argument of arguments_) this.flow(argument, declaration);
		}
		if (receiver && /typescript\/lib\/lib\..*\.d\.ts$/.test(file) && ["filter", "reverse", "slice", "sort", "next"].includes(name)) this.flow(receiver, node);
		if (receiver && name === "bind") this.flow(receiver, node);
		if (/bun-types\/sqlite\.d\.ts$/.test(file) && name === "transaction") {
			this.point(node, node);
			for (const argument of arguments_) this.registeredCallbacks.add(argument);
		}
		const invokeTransactionMode = (): void => {
			if (receiver && ["immediate", "deferred", "exclusive"].includes(name) && /bun-types\/sqlite\.d\.ts$/.test(file)) {
				for (const transaction of this.points.get(receiver) ?? []) {
					if (!ts.isCallExpression(transaction)) continue;
					const callback = transaction.arguments[0];
					if (callback) for (const implementation of this.points.get(callback) ?? []) this.invoke(node, implementation, arguments_);
				}
			}		};
		invokeTransactionMode();

	}

	private recordNativeEvents(node: ts.NewExpression | ts.CallExpression, receiver: ts.LeftHandSideExpression | undefined, eventCallback: boolean, arguments_: never[] | ts.NodeArray<ts.Expression>, name: string, file: string) {
		if (ts.isCallExpression(node) && receiver && eventCallback) {
			this.eventRegistrations.set(node, receiver);
			for (const argument of arguments_) this.registeredCallbacks.add(argument);
			this.dispatchEvents();
		}
		if (ts.isCallExpression(node) && receiver && name === "emit" && /@types\/node\/(?:events|process)\.d\.ts$/.test(file)) {
			this.eventEmissions.set(node, receiver); this.dispatchEvents();
		}
		if (ts.isCallExpression(node) && receiver && name === "abort" && /lib\.dom\.d\.ts$|bun-types\//.test(file)) {
			this.eventEmissions.set(node, receiver); this.dispatchEvents();
		}
	}

	private invokeSourceTargets(node: ts.NewExpression | ts.CallExpression, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		const invokeConstructor = (): void => {
			if (ts.isNewExpression(node)) {
				const declaration = this.declaration(node.expression);
				if (declaration && ts.isClassDeclaration(declaration)) {
					for (const member of declaration.members) if (ts.isConstructorDeclaration(member)) this.invoke(node, member, arguments_);
				}
			}
		};
		invokeConstructor();
		for (const target of this.points.get(node.expression) ?? []) {
			this.invoke(node, target, arguments_);
			if (ts.isCallExpression(target) && /bun-types\/sqlite\.d\.ts$/.test(this.nativeOwner(target)) && memberName(target.expression) === "transaction") {
				const callback = target.arguments[0];
				if (callback) for (const implementation of this.points.get(callback) ?? []) this.invoke(node, implementation, arguments_);
			}
		}
	}

	private flowExpressions(node: ts.Node) {
		if (ts.isConditionalExpression(node)) { this.flow(node.whenTrue, node); this.flow(node.whenFalse, node); }
		const flowBinaryExpression = (): void => {
			if (ts.isBinaryExpression(node)) {
				if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
					this.flow(node.left, node); this.flow(node.right, node);
				}
				if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
					const target = this.declaration(node.left);
					if (target) this.inScope(node, () => this.flow(node.right, target));
					if (ts.isElementAccessExpression(node.left)) {
						const receiver = this.declaration(node.left.expression);
						if (receiver) this.inScope(node, () => this.flow(node.right, receiver));
					}
				}
			}
		};
		flowBinaryExpression();
		if (ts.isReturnStatement(node) && node.expression) {
			const owner = scope(node), expressions = this.returns.get(owner) ?? []; expressions.push(node.expression); this.returns.set(owner, expressions);
		}
		if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) this.returns.set(node, [node.body]);
		if (ts.isAwaitExpression(node) || ts.isSpreadElement(node)) this.flow(node.expression, node);
		if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) if (ts.isSpreadElement(element)) this.flow(element.expression, node);
		const flowIteration = (): void => {
			if (ts.isForOfStatement(node)) {
				const declaration = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0] : undefined;
				if (declaration) this.watch(node.expression, () => {
					for (const value of this.points.get(node.expression) ?? []) {
						if (ts.isArrayLiteralExpression(value)) for (const element of value.elements) this.flow(element, declaration);
						else this.point(declaration, value);
					}
				});
			}		};
		flowIteration();

	}

	private flowMember(node: ts.Node) {
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const key = memberName(node);
			if (key) this.propertyOnce(node.expression, key, node);
			else if (ts.isElementAccessExpression(node)) this.watch(node.expression, () => {
				for (const value of this.points.get(node.expression) ?? []) if (ts.isObjectLiteralExpression(value)) {
					for (const property of value.properties) this.flow(property, node);
				}
			});
			if (ts.isPropertyAccessExpression(node) && node.name.text === "value") {
				const receiver = this.resolve(node.expression);
				if (receiver && ts.isCallExpression(receiver) && memberName(receiver.expression) === "next" && /typescript\/lib\//.test(this.nativeOwner(receiver))) this.flow(node.expression, node);
			}
			const declaration = this.declaration(node);
			if (declaration && !ts.isMethodSignature(declaration) && !ts.isPropertySignature(declaration)) this.flow(declaration, node);
			if (key === "signal") this.watch(node.expression, () => {
				for (const value of this.points.get(node.expression) ?? []) if (ts.isNewExpression(value) && memberName(value.expression) === "AbortController" && /lib\.dom\.d\.ts$|bun-types\//.test(this.nativeOwner(value))) this.point(node, value);
			});
		}
	}

	private flowBindings(node: ts.Node) {
		if (node.kind === ts.SyntaxKind.ThisKeyword) {
			let owner = scope(node);
			while (ts.isArrowFunction(owner)) owner = scope(owner);
			const receivers = this.receivers.get(owner) ?? []; receivers.push(node); this.receivers.set(owner, receivers);
		}
		if (ts.isIdentifier(node)) {
			const declaration = this.declaration(node);
			if (declaration && declaration !== node.parent) this.flow(declaration, node);
		}
		if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) this.flow(node.initializer, node);
		if (ts.isShorthandPropertyAssignment(node)) {
			const declaration = this.checker.getShorthandAssignmentValueSymbol(node)?.valueDeclaration;
			if (declaration) this.flow(declaration, node);
		}
		if (ts.isBindingElement(node)) {
			const owner = node.parent.parent;
			if (ts.isObjectBindingPattern(node.parent)) this.propertyOnce(owner, memberName(node.propertyName ?? node.name), node);
			else this.propertyOnce(owner, String(node.parent.elements.indexOf(node)), node);
		}
	}

	private flowCollectionConstructor(node: ts.NewExpression | ts.CallExpression, file: string, name: string, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		if (!(ts.isNewExpression(node) && /typescript\/lib\//.test(file) && ["Map", "Set"].includes(name))) return;
		const input = arguments_[0];
		if (input) for (const value of this.points.get(input) ?? []) {
			if (!ts.isArrayLiteralExpression(value)) continue;
			if (name === "Set") for (const element of value.elements) this.flow(element, node);
			else {
				const flowMapTuples = (): void => {
					const directPair = value.elements[1];
					// map(callback => [key,value]) carries a tuple; literal map inputs
					// carry an array of those tuples. Resolve both without key guessing.
					for (const element of value.elements) {
						const pair = this.resolve(element);
						if (pair && ts.isArrayLiteralExpression(pair) && pair.elements[1]) this.flow(pair.elements[1], node);
					}
					if (directPair && !ts.isArrayLiteralExpression(this.resolve(value.elements[0] ?? value) ?? value)) this.flow(directPair, node);				};
				flowMapTuples();

			}
		}
	}

	private flowSchemaCallbacks(file: string, node: ts.NewExpression | ts.CallExpression, arguments_: never[] | ts.NodeArray<ts.Expression>, receiver: ts.LeftHandSideExpression | undefined, name: string) {
		if (!(/\/zod\//.test(file))) return;
		this.point(node, node);
		const callbacks = this.schemaCallbacks.get(node) ?? new Set<ts.Node>(); this.schemaCallbacks.set(node, callbacks);
		for (const argument of arguments_) {
			const callback = this.resolve(argument);
			if (callback && isFunction(callback)) { callbacks.add(callback); this.registeredCallbacks.add(argument); }
		}
		if (receiver) for (const value of this.points.get(receiver) ?? []) {
			for (const callback of this.schemaCallbacks.get(value) ?? []) {
				callbacks.add(callback);
				if (["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(name)) this.invoke(node, callback, arguments_, false);
			}
		}
		if (["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(name) && arguments_[0]) this.flow(arguments_[0], node);
	}

	private flowAsyncStorage(receiver: ts.LeftHandSideExpression | undefined, file: string, name: string, arguments_: never[] | ts.NodeArray<ts.Expression>, node: ts.NewExpression | ts.CallExpression) {
		if (receiver && /@types\/node\/async_hooks\.d\.ts$/.test(file)) {
			const storage = this.declaration(receiver);
			if (name === "run" || name === "enterWith") {
				const value = arguments_[0]; if (value && storage) this.flow(value, storage);
				const callback = arguments_[1];
				if (callback) for (const target of this.points.get(callback) ?? []) this.invoke(node, target, arguments_.slice(2), false);
			}
			if (name === "getStore") this.flow(receiver, node);
		}
	}

	private invokeBunCallbacks(file: string, name: string, arguments_: readonly ts.Expression[], node: ts.NewExpression | ts.CallExpression): void {
		if (!(/bun-types\//.test(file) && ["serve", "listen", "connect"].includes(name))) return;
		const options = arguments_[0];
		if (!options) return;
		for (const value of this.points.get(options) ?? []) {
			if (ts.isObjectLiteralExpression(value)) this.invokeServerProperties(value, node);
		}
	}
	private invokeServerProperties(value: ts.ObjectLiteralExpression, node: ts.NewExpression | ts.CallExpression): void {
		for (const property of value.properties) {
			if (!property.name || !["fetch", "error", "websocket", "socket"].includes(memberName(property.name))) continue;
			for (const callback of this.points.get(property) ?? []) this.invokeServerCallback(callback, node);
		}
	}
	private invokeServerCallback(callback: ts.Node, node: ts.NewExpression | ts.CallExpression): void {
		if (isFunction(callback)) this.invoke(node, callback, [], false);
		if (!ts.isObjectLiteralExpression(callback)) return;
		for (const handler of callback.properties) {
			for (const target of this.points.get(handler) ?? []) this.invoke(node, target, [], false);
		}
	}

	private invokeAiCallbacks(file: string, name: string, node: ts.NewExpression | ts.CallExpression, execute: () => void, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		if (/\/ai\/dist\/index\.d\.ts$/.test(file) && name === "streamText") {
			const manifest = join(dirname(dirname(file)), "package.json");
			const metadata = object(readJson(manifest));
			if (metadata.version !== "6.0.141") fail("tool_version", manifest, "AI SDK callback contract requires 6.0.141");
			const contract = this.dependencyContracts.get("ai") ?? { version: "6.0.141", sha256: digest(readFileSync(manifest)), operations: [] };
			if (!contract.operations.some((row) => JSON.stringify(row) === JSON.stringify(this.locus(node)))) contract.operations.push(this.locus(node));
			this.dependencyContracts.set("ai", contract);
			const watched = this.nativeWatches.get(node) ?? new Set<ts.Node>(); this.nativeWatches.set(node, watched);
			const observe = (value: ts.Node): void => { if (!watched.has(value)) { watched.add(value); this.watch(value, execute); } };
			const visited = new Set<ts.Node>();
			const propertyCallbacks = (property: ts.ObjectLiteralElementLike, tools: boolean): void => {
				observe(property);
				if (ts.isSpreadAssignment(property)) {
					observe(property.expression);
					for (const inner of this.points.get(property.expression) ?? []) callbacks(inner, tools);
					return;
				}
				const key = property.name ? memberName(property.name) : "";
				if (["onError", "onFinish", "onChunk", "onStepFinish"].includes(key) || tools && key === "execute") {
					for (const target of this.points.get(property) ?? []) this.invoke(node, target, [], false);
				}
				if (key === "tools" || tools) {
					for (const inner of this.points.get(property) ?? []) callbacks(inner, true);
				}
			};
			const callbacks = (value: ts.Node, tools = false): void => {
				if (visited.has(value)) return;
				visited.add(value); observe(value);
				if (ts.isObjectLiteralExpression(value)) {
					for (const property of value.properties) propertyCallbacks(property, tools);
				}
				for (const inner of this.points.get(value) ?? []) if (inner !== value) callbacks(inner, tools);
			};
			if (arguments_[0]) callbacks(arguments_[0]);
		}
	}

	private invokeNativeCallbacks(immediate: boolean, scheduled: boolean, arguments_: never[] | ts.NodeArray<ts.Expression>, node: ts.NewExpression | ts.CallExpression, receiver: ts.LeftHandSideExpression | undefined) {
		if (!immediate && !scheduled) return;
		for (const argument of arguments_) {
			for (const target of this.points.get(argument) ?? []) {
				this.invoke(node, target, [], false);
				const flowCallbackParameter = (): void => {
					if (immediate && isFunction(target) && receiver) {
						const parameter = target.parameters[0];
						if (parameter) for (const value of this.points.get(receiver) ?? []) {
							if (ts.isArrayLiteralExpression(value)) for (const element of value.elements) this.flow(element, parameter);
							else this.point(parameter, value);
						}
					}				};
				flowCallbackParameter();

			}
		}
	}

	private invokeModuleFactory(node: ts.NewExpression | ts.CallExpression, receiver: ts.LeftHandSideExpression | undefined, name: string, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		if (ts.isCallExpression(node) && receiver && name === "module") {
			const binding = this.declaration(receiver);
			const owner = binding && ts.isBindingElement(binding) ? binding.parent.parent : undefined;
			const load = owner && ts.isVariableDeclaration(owner) ? owner.initializer : undefined;
			if (load && ts.isCallExpression(load) && load.arguments[0] && this.strings(load.arguments[0]).some((row) => row.value === "bun:test") && ts.isCallExpression(load.expression) && ts.isPropertyAccessExpression(load.expression.expression)) {
				const provider = this.resolve(load.expression.expression.expression);
				if (provider && /@types\/node\/module\.d\.ts$/.test(provider.getSourceFile().fileName) && memberName(load.expression.expression) === "createRequire") {
					for (const argument of arguments_) this.registeredCallbacks.add(argument);
					const invokeImportedFactory = (): void => {
						const module = arguments_[0], factory = arguments_[1];
						if (module && factory && this.strings(module).some((row) => this.sourceFiles.some((source) => source.statements.some((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === row.value)))) {
							for (const target of this.points.get(factory) ?? []) this.invoke(node, target, [], false);
						}					};
					invokeImportedFactory();

				}
			}
		}
	}

	private activateSpawnedSource(node: ts.NewExpression | ts.CallExpression, file: string, name: string, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		if (ts.isCallExpression(node) && /child_process\.d\.ts$|bun-types\//.test(file) && ["spawn", "spawnSync", "execFile", "execFileSync"].includes(name)) {
			const input = arguments_[0] ? this.resolve(arguments_[0]) : undefined;
			let commands = input ? this.commandArrays(input) : [];
			if (input && ts.isObjectLiteralExpression(input)) {
				const property = input.properties.find((property) => property.name && memberName(property.name) === "cmd");
				if (property && ts.isPropertyAssignment(property)) commands = this.commandArrays(property.initializer);
			}
			if (/child_process\.d\.ts$/.test(file) && arguments_[0] && arguments_[1]) {
				const binary = arguments_[0]; commands = this.commandArrays(arguments_[1]).map((array) => [binary, ...array]);
			}
			const activateCommands = (): void => {
				for (const words of commands) {
					const binary = words[0];
					if (!binary || !this.strings(binary).some((row) => row.value === process.execPath || /(?:^|\/)(?:bun|node|tsx)$/.test(row.value))) continue;
					const entry = words[1]; if (!entry) continue;
					for (const value of this.strings(entry, true)) {
						const absolute = resolve(this.root, value.value), source = this.program.getSourceFile(absolute) ?? this.program.getSourceFile(absolute.replace(/\.js$/, ".ts"));
						if (!source || !this.sourceFiles.includes(source)) continue;
						const path = this.path(node);
						if (path && !this.roots.has(resolve(source.fileName))) {
							this.roots.set(resolve(source.fileName), path.root);
							this.activate(source, { root: path.root, chain: [...path.chain, this.locus(node)] });
						}
					}
				}			};
			activateCommands();

		}
	}

	private flowComposedAbort(node: ts.NewExpression | ts.CallExpression, receiver: ts.LeftHandSideExpression | undefined, name: string, file: string, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		if (ts.isCallExpression(node) && receiver && memberName(receiver) === "AbortSignal" && name === "any" && /lib\.dom\.d\.ts$|bun-types\//.test(file)) {
			const signals = arguments_[0];
			if (signals) this.watch(signals, () => {
				for (const value of this.points.get(signals) ?? []) {
					if (ts.isArrayLiteralExpression(value)) for (const signal of value.elements) this.flow(signal, node);
				}
			});
		}
	}

	private invokeElectronHandler(name: string, file: string, arguments_: never[] | ts.NodeArray<ts.Expression>) {
		if (!(name === "handle" && /electron\/electron\.d\.ts$/.test(file))) return;
		// Electron IPC handlers are endpoint registrations, not EventEmitter
		// listeners. Only concrete renderer invocations activate their bodies.
		for (const argument of arguments_) this.registeredCallbacks.add(argument);
		const channel = arguments_[0], callback = arguments_[1];
		if (channel && callback) for (const invocation of this.calls) {
			if (memberName(invocation.expression) !== "invoke" || !/electron\/electron\.d\.ts$/.test(this.nativeOwner(invocation)) || !this.path(invocation)) continue;
			const requested = invocation.arguments[0];
			if (!requested || !this.strings(requested).some((entry) => this.strings(channel).some((registered) => registered.value === entry.value))) continue;
			for (const target of this.points.get(callback) ?? []) this.invoke(invocation, target, invocation.arguments.slice(1), false);
		}
	}

	structure(): { definition: Locus; implementations: Locus[]; operations: Locus[]; families: string[] }[] {
		const records: { definition: Locus; implementations: Locus[]; operations: Locus[]; families: string[] }[] = [];
		for (const source of this.sourceFiles) walk(source, (node) => {
			if (!ts.isInterfaceDeclaration(node) || !ts.isModuleBlock(node.parent) || !ts.isModuleDeclaration(node.parent.parent) || node.parent.parent.name.text !== "Storage") return;
			const contracts = new Set(this.checker.getTypeAtLocation(node).getProperties().map((symbol) => symbol.valueDeclaration).filter((value) => value !== undefined));
			const implementations: Locus[] = [], operations: Locus[] = [];
			const families = new Set<string>();
			for (const call of this.calls) {
				const declaration = this.declaration(call.expression);
				if (!declaration || !contracts.has(declaration)) continue;
				for (const target of this.targets.get(call) ?? []) {
					implementations.push(this.locus(target));
					this.collectTargetFamilies(target, families);

				}
				if (this.path(call)) operations.push(this.locus(call));
			}
			records.push({ definition: this.locus(node, node.name.text), implementations, operations, families: [...families].sort() });
		});
		return records;
	}
	private collectTargetFamilies(target: ts.Node, families: Set<string>): void {
						const pending = [target], seen = new Set<ts.Node>();
						for (let index = 0; index < pending.length; index++) {
							const owner = pending[index]; if (!owner || seen.has(owner)) continue; seen.add(owner);
							for (const operation of this.calls) {
								if (scope(operation) !== owner) continue;
								pending.push(...this.targets.get(operation) ?? []);
								const argument = operation.arguments[0];
								this.collectSqlFamilies(operation, argument, families);
							}
						}					
	}
	private collectSqlFamilies(operation: ts.CallExpression, argument: ts.Expression | undefined, families: Set<string>): void {
								if (argument && /bun-types\/sqlite\.d\.ts$/.test(this.nativeOwner(operation))) for (const row of this.sql(argument)) {
									for (const match of row.value.matchAll(/\b(?:from|join|into|update)\s+["`[]?([\w]+)["`\]]?/gi)) if (match[1] && match[1].toLowerCase() !== "set" && !match[1].includes("__CENSUS_DYNAMIC__")) families.add(match[1]);
								}
	}

	role(node: ts.Node): "migration" | "archive" | "product" {
		const owner = scope(node);
		if (isFunction(owner)) {
			const role = ledgerCensusRole(this.locus(owner, owner.name?.getText() ?? ""));
			if (role !== "product") return role;
		}
		const path = this.path(node);
		for (const site of path?.chain ?? []) {
			for (const call of this.calls) {
				if (call.getSourceFile().fileName !== resolve(this.root, site.path) || this.locus(call).line !== site.line) continue;
				for (const target of this.targets.get(call) ?? []) if (isFunction(target)) {
					const role = ledgerCensusRole(this.locus(target, target.name?.getText() ?? ""));
					if (role !== "product") return role;
				}
			}
		}
		return "product";
	}
	path(node: ts.Node): { root: Locus; chain: Locus[] } | undefined { return this.activeBranch(node) ? this.reachable.get(scope(node)) : undefined; }
	edge(origin: ts.Node, terminal: ts.Node, aliases: Locus[] = []): Edge | undefined {
		const path = this.path(terminal);
		if (!path) return undefined;
		return { originDefinition: this.locus(origin), importOrAliasPath: [...this.importPath(terminal.getSourceFile(), origin.getSourceFile()), ...aliases], forwardingCallPath: path.chain, terminalProductOperation: this.locus(terminal), rootInvocation: path.root };
	}
	private importPath(from: ts.SourceFile, to: ts.SourceFile): Locus[] {
		const paths = new Map<ts.Node, Locus[]>([[from, []]]);
		for (const [source, path] of paths) {
			if (source === to) return path;
			for (const link of this.links.get(source) ?? []) {
				if (ts.isSourceFile(link.target) && !paths.has(link.target)) paths.set(link.target, [...path, this.locus(link.site)]);
			}
		}
		return [];
	}
	strings(input: ts.Node, patterns = false, seen = new Set<ts.Node>(), bindings = new Map<ts.ParameterDeclaration, ts.Expression>()): { value: string; origin: ts.Node }[] {
		const node = unwrap(input);
		if (seen.has(node)) return [];
		seen.add(node);
		const nested = (part: ts.Node) => this.strings(part, patterns, new Set(seen), bindings);
		const parameter = this.declaration(node);
		if (parameter && ts.isParameter(parameter)) {
			const argument = bindings.get(parameter);
			if (argument) return nested(argument);
		}
		if (ts.isStringLiteralLike(node)) return [{ value: node.text, origin: node }];
		const environmentPathStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (patterns && ts.isPropertyAccessExpression(node) && node.expression.getText() === "import.meta" && ["dir", "dirname", "path", "filename", "url"].includes(node.name.text)) {
				const path = relative(this.root, node.getSourceFile().fileName);
				return [{ value: ["dir", "dirname"].includes(node.name.text) ? dirname(path) : path, origin: node }];
			}
			if (patterns && ts.isNewExpression(node) && memberName(node.expression) === "URL") {
				const part = node.arguments?.[0], base = node.arguments?.[1];
				if (part && base) return nested(base).flatMap((base) => nested(part).map((part) => ({ value: join(dirname(base.value), part.value), origin: node })));
			}
			return undefined;
		};
		const environmentPathStringsResult = environmentPathStrings();
		if (environmentPathStringsResult !== undefined) return environmentPathStringsResult;
		const compoundStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (ts.isTemplateExpression(node)) return this.templateStrings(node, nested);
			if (ts.isBinaryExpression(node)) {
				if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return nested(node.left).flatMap((left) => nested(node.right).map((right) => ({ value: left.value + right.value, origin: node })));
				if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
					const left = nested(node.left), right = nested(node.right);
					return left.length && right.length ? [...left, ...right] : [];
				}
			}
			if (ts.isConditionalExpression(node)) {
				const yes = nested(node.whenTrue), no = nested(node.whenFalse);
				if (patterns && node.whenFalse.kind === ts.SyntaxKind.Identifier && node.whenFalse.getText() === "undefined") return yes;
				if (patterns && node.whenTrue.kind === ts.SyntaxKind.Identifier && node.whenTrue.getText() === "undefined") return no;
				return yes.length && no.length ? [...yes, ...no] : [];
			}
			return undefined;
		};
		const compoundStringsResult = compoundStrings();
		if (compoundStringsResult !== undefined) return compoundStringsResult;
		const callStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (ts.isCallExpression(node)) {
				const owner = this.nativeOwner(node), name = memberName(node.expression);
				const spawnOutputStrings = (): { value: string; origin: ts.Node }[] | undefined => {
					if (patterns && /bun-types\//.test(owner) && ["spawn", "spawnSync"].includes(name) && node.arguments[0]) {
						let command = this.resolve(node.arguments[0]);
						if (command && ts.isObjectLiteralExpression(command)) {
							const property = command.properties.find((row) => row.name?.getText() === "cmd");
							if (property && ts.isPropertyAssignment(property)) command = this.resolve(property.initializer);
						}
						if (command && ts.isArrayLiteralExpression(command)) {
							const words = command.elements.flatMap(nested).map((row) => row.value);
							if (words[0] === "git" && words.includes("ls-files")) return [{ value: "$inventory/**/*", origin: node }];
						}
					}
					return undefined;
				};
				const spawnOutputStringsResult = spawnOutputStrings();
				if (spawnOutputStringsResult !== undefined) return spawnOutputStringsResult;
				const nativePathStrings = (): { value: string; origin: ts.Node }[] | undefined => {
					if (patterns) {
						const ambient = this.ambientCallStrings(node, owner, name, nested);
						if (ambient !== undefined) return ambient;
					}
					if (/\/node\/path\.d\.ts$/.test(owner) && ["join", "resolve"].includes(name)) {
						let values = [""];
						for (const argument of node.arguments) {
							const parts = nested(argument); if (!parts.length) return [];
							values = values.flatMap((value) => parts.map((part) => value ? join(value, part.value) : part.value));
						}
						return values.map((value) => ({ value, origin: node }));
					}
					return undefined;
				};
				const nativePathStringsResult = nativePathStrings();
				if (nativePathStringsResult !== undefined) return nativePathStringsResult;
				const mappedJoinStrings = (): { value: string; origin: ts.Node }[] | undefined => {
					if (name === "join" && ts.isPropertyAccessExpression(node.expression)) {
						const receiver = node.expression.expression;
						if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && memberName(receiver.expression) === "map") {
							const mapper = receiver.arguments[0];
							if (mapper && ts.isArrowFunction(mapper) && ts.isStringLiteralLike(mapper.body)) return [{ value: mapper.body.text, origin: mapper.body }];
						}
					}
					return undefined;
				};
				const mappedJoinStringsResult = mappedJoinStrings();
				if (mappedJoinStringsResult !== undefined) return mappedJoinStringsResult;
				const targets = this.targets.get(node);
				if (targets?.size) return [...targets].flatMap((target) => {
					const bound = new Map(bindings);
					if (isFunction(target)) for (let index = 0; index < target.parameters.length; index++) {
						const parameter = target.parameters[index], argument = node.arguments[index];
						if (parameter && argument) bound.set(parameter, argument);
					}
					return (this.returns.get(target) ?? []).flatMap((value) => this.strings(value, patterns, new Set(seen), bound));
				});
			}
			return undefined;
		};
		const callStringsResult = callStrings();
		if (callStringsResult !== undefined) return callStringsResult;
		const processStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (patterns && ts.isPropertyAccessExpression(node) && node.expression.getText() === "process.env") return [{ value: `$env.${node.name.text}`, origin: node }];
			if (ts.isPropertyAccessExpression(node) && node.name.text === "execPath" && /@types\/node\/process\.d\.ts$/.test(this.declaration(node)?.getSourceFile().fileName ?? "")) return [{ value: process.execPath, origin: node }];
			if (patterns && ts.isElementAccessExpression(node)) {
				const base = this.resolve(node.expression);
				if (node.expression.getText() === "process.argv" || base && ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.expression.getText() === "process.argv") return [{ value: `$argv.${node.argumentExpression.getText()}`, origin: node }];
			}
			return undefined;
		};
		const processStringsResult = processStrings();
		if (processStringsResult !== undefined) return processStringsResult;
		return this.resolvedStrings(node, patterns, bindings, nested);
	}
	private ambientCallStrings(node: ts.CallExpression, owner: string, name: string, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] | undefined {
					if (/\/node\/url\.d\.ts$/.test(owner) && name === "fileURLToPath" && node.arguments[0]) return nested(node.arguments[0]);
					if (/\/node_modules\//.test(owner) && name === "cwd") return [{ value: ".", origin: node }];
					if (/\/node\/fs\.d\.ts$/.test(owner) && name === "mkdtempSync" && node.arguments[0]) return nested(node.arguments[0]).map((row) => ({ ...row, value: `${row.value}*` }));

					if (/\/node\/os\.d\.ts$/.test(owner) && ["homedir", "tmpdir"].includes(name)) return [{ value: `$${name}`, origin: node }];
					if (/\/node_modules\//.test(owner) && name === "randomUUID") return [{ value: "*", origin: node }];
					if (name === "toString" && ts.isPropertyAccessExpression(node.expression) && ts.isCallExpression(node.expression.expression) && memberName(node.expression.expression.expression) === "randomBytes" && /\/node\/crypto\.d\.ts$/.test(this.nativeOwner(node.expression.expression))) return [{ value: "*", origin: node }];
					return undefined;
	}

	private templateStrings(node: ts.TemplateExpression, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] {
				let values = [node.head.text];
				for (const span of node.templateSpans) {
					const parts = nested(span.expression);
					if (!parts.length) return [];
					values = values.flatMap((value) => parts.map((part) => value + part.value + span.literal.text));
				}
				return values.map((value) => ({ value, origin: node }));
			
	}

	private promiseBindingStrings(declaration: ts.BindingElement, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] | undefined {
		const owner = declaration.parent.parent;
		if (!ts.isVariableDeclaration(owner) || !owner.initializer) return undefined;
		const initializer = ts.isAwaitExpression(owner.initializer) ? owner.initializer.expression : owner.initializer;
		if (!ts.isCallExpression(initializer) || memberName(initializer.expression) !== "all" || !initializer.arguments[0] || !ts.isArrayLiteralExpression(initializer.arguments[0])) return undefined;
		const value = initializer.arguments[0].elements[declaration.parent.elements.indexOf(declaration)];
		return value ? nested(value) : undefined;
	}
	private globCreation(value: ts.Node | undefined): ts.NewExpression | undefined {
		if (!value) return undefined;
		if (ts.isNewExpression(value)) return value;
		if (ts.isVariableDeclaration(value) && value.initializer && ts.isNewExpression(value.initializer)) return value.initializer;
		return undefined;
	}
	private globStrings(node: ts.Node, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] | undefined {
		if (!ts.isCallExpression(node) || !/bun-types\//.test(this.nativeOwner(node)) || !["scan", "scanSync"].includes(memberName(node.expression)) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
		const created = this.globCreation(this.resolve(node.expression.expression));
		return created?.arguments?.[0] ? nested(created.arguments[0]) : undefined;
	}

	private iterableDeclarationStrings(declaration: ts.Declaration | undefined, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] | undefined {
		if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent) || !ts.isForOfStatement(declaration.parent.parent)) return undefined;
		const iterable = declaration.parent.parent.expression;
		const values = nested(iterable);
		if (values.length) return values;
		if (!ts.isCallExpression(iterable) || !ts.isPropertyAccessExpression(iterable.expression) || !["scan", "scanSync"].includes(memberName(iterable.expression))) return undefined;
		const glob = this.declaration(iterable.expression.expression);
		if (!glob || !ts.isVariableDeclaration(glob) || !glob.initializer || !ts.isNewExpression(glob.initializer) || !glob.initializer.arguments?.[0]) return undefined;
		return nested(glob.initializer.arguments[0]);
	}
	private containerCallStrings(node: ts.Node, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] | undefined {
		if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
		const name = memberName(node.expression);
		if (["sort", "filter", "split", "toString", "trim", "catch"].includes(name)) return nested(node.expression.expression);
		if (name === "text" && /(?:bun-types\/|typescript\/lib\/lib\.dom\.d\.ts$)/.test(this.nativeOwner(node))) {
			const receiver = this.resolve(node.expression.expression);
			if (receiver && ts.isNewExpression(receiver) && memberName(receiver.expression) === "Response" && receiver.arguments?.[0]) return nested(receiver.arguments[0]);
		}
		if (name === "from" && node.arguments[0] && /typescript\/lib\//.test(this.nativeOwner(node))) return nested(node.arguments[0]);
		return undefined;
	}

	private resolvedStrings(node: ts.Node, patterns: boolean, bindings: Map<ts.ParameterDeclaration, ts.Expression>, nested: (node: ts.Node) => { value: string; origin: ts.Node }[]): { value: string; origin: ts.Node }[] {
		const declaration = this.declaration(node);
		if (declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
			const initial = nested(declaration.initializer);
			if (initial.length) return initial;
		}
		if (patterns && ts.isPropertyAccessExpression(node) && node.name.text === "stdout") return nested(node.expression);
		const patternBindingStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (!patterns) return undefined;
			if (declaration && ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)) {
				const values = this.promiseBindingStrings(declaration, nested);
				if (values !== undefined) return values;
			}
			if (declaration && ts.isPropertyAssignment(declaration)) return nested(declaration.initializer);
			return this.globStrings(node, nested);
		};
		const patternBindingStringsResult = patternBindingStrings();
		if (patternBindingStringsResult !== undefined) return patternBindingStringsResult;
		const pointed = [...this.points.get(node) ?? []].filter((value) => value !== node && (ts.isStringLiteralLike(value) || ts.isCallExpression(value)));
		if (pointed.length) {
			const values = pointed.flatMap(nested);
			if (values.length) return values;
		}
		const iterablePatternStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (!patterns) return undefined;
			const iterable = this.iterableDeclarationStrings(declaration, nested);
			if (iterable !== undefined) return iterable;
			if (declaration && ts.isPropertySignature(declaration)) return [{ value: `$input.${declaration.name.getText()}`, origin: declaration }];
			if (ts.isAwaitExpression(node) || ts.isSpreadElement(node)) return nested(node.expression);
			if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(nested);
			return this.containerCallStrings(node, nested);
		};
		const iterablePatternStringsResult = iterablePatternStrings();
		if (iterablePatternStringsResult !== undefined) return iterablePatternStringsResult;
		const parameterStrings = (): { value: string; origin: ts.Node }[] | undefined => {
			if (declaration && ts.isParameter(declaration)) {
				const bound = bindings.get(declaration);
				if (bound) return nested(bound);
				const owner = declaration.parent;
				if (isFunction(owner)) {
					const index = owner.parameters.indexOf(declaration);
					const values = this.calls.flatMap((call) => {
						if (!this.path(call) || !this.targets.get(call)?.has(owner)) return [];
						const argument = call.arguments[index] ?? declaration.initializer;
						return argument ? nested(argument) : [];
					});
					if (values.length) return values;
				}
			}
			return undefined;
		};
		const parameterStringsResult = parameterStrings();
		if (parameterStringsResult !== undefined) return parameterStringsResult;
		return [];
	}

	sql(node: ts.Node): { value: string; origin: ts.Node }[] {
		const resolved = this.resolve(node) ?? node;
		if (!ts.isTemplateExpression(resolved)) return this.strings(node);
		let values = [resolved.head.text];
		for (const span of resolved.templateSpans) {
			const parts = this.strings(span.expression);
			values = values.flatMap((value) => (parts.length ? parts : [{ value: "__CENSUS_DYNAMIC__" }]).map((part) => value + part.value + span.literal.text));
		}
		return values.map((value) => ({ value, origin: resolved }));
	}
	commandArrays(node: ts.Node, seen = new Set<ts.Node>()): ts.Expression[][] {
		if (seen.has(node)) return [];
		seen.add(node);
		const value = this.resolve(node) ?? node;
		const nested = (node: ts.Node) => this.commandArrays(node, new Set(seen));
		if (ts.isArrayLiteralExpression(value)) {
			let arrays: ts.Expression[][] = [[]];
			for (const element of value.elements) {
				const parts = ts.isSpreadElement(element) ? nested(element.expression) : [[element]];
				arrays = arrays.flatMap((array) => parts.map((part) => [...array, ...part]));
			}
			return arrays;
		}
		if (ts.isConditionalExpression(value)) return [...nested(value.whenTrue), ...nested(value.whenFalse)];
		const declaration = this.declaration(node);
		if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return nested(declaration.initializer);
		if (declaration && ts.isBindingElement(declaration) && declaration.dotDotDotToken && ts.isArrayBindingPattern(declaration.parent)) {
			const owner = declaration.parent.parent;
			if (ts.isVariableDeclaration(owner) && owner.initializer) return nested(owner.initializer).map((array) => array.slice(declaration.parent.elements.indexOf(declaration)));
		}
		if (declaration && ts.isParameter(declaration) && isFunction(declaration.parent)) {
			const owner = declaration.parent, index = owner.parameters.indexOf(declaration);
			return this.calls.flatMap((call) => this.path(call) && this.targets.get(call)?.has(owner) && call.arguments[index] ? nested(call.arguments[index]) : []);
		}
		return [...this.points.get(node) ?? []].filter((value) => value !== node && ts.isArrayLiteralExpression(value)).flatMap(nested);
	}
	runtimeValues(input: ts.Node, bindings: Map<ts.ParameterDeclaration, ts.Expression>, seen = new Set<ts.Node>()): ts.Node[] {
		const node = unwrap(input);
		if (seen.has(node)) return [];
		seen.add(node);
		const nested = (node: ts.Node) => this.runtimeValues(node, bindings, new Set(seen));
		if (implementation(node) || ts.isObjectLiteralExpression(node) || ts.isNewExpression(node)) return [node];
		const declaration = this.declaration(node);
		if (declaration && ts.isParameter(declaration) && bindings.has(declaration)) {
			const argument = bindings.get(declaration); return argument ? nested(argument) : [];
		}
		if (declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer) return nested(declaration.initializer);
		if (ts.isPropertyAccessExpression(node)) {
			const properties = nested(node.expression).flatMap((value) => ts.isObjectLiteralExpression(value) ? value.properties.filter((property) => property.name && memberName(property.name) === node.name.text).flatMap(nested) : []);
			if (properties.length) return properties;
		}
		if (declaration && (implementation(declaration) || this.nativeEventContract(node))) return [declaration];
		return [...this.points.get(node) ?? []];
	}
	publisherValues(call: ts.CallExpression, target: ts.Node): { value: string; origin: ts.Node }[] {
		const argument = call.arguments[0]; if (!argument) return [];
		const owner = scope(call);
		if (!isFunction(owner)) return this.values(argument);
		const bindings = new Map<ts.ParameterDeclaration, ts.Expression>();
		const input = (node: ts.Node, seen = new Set<ts.Node>()): { value: string; origin: ts.Node }[] => {
			const declaration = this.declaration(node);
			if (declaration && ts.isParameter(declaration) && !seen.has(declaration)) {
				seen.add(declaration); const argument = bindings.get(declaration);
				if (argument) return input(argument, seen);
			}
			return this.values(node);
		};
		const records: { value: string; origin: ts.Node }[] = [];
		const callers = this.calls.filter((candidate) => this.path(candidate) && this.targets.get(candidate)?.has(owner));
		if (!callers.length) return this.values(argument);
		for (const caller of callers) {
			bindings.clear();
			for (let index = 0; index < owner.parameters.length; index++) {
				const parameter = owner.parameters[index], argument = caller.arguments[index];
				if (parameter && argument) bindings.set(parameter, argument);
			}
			const possible = this.runtimeValues(call.expression, bindings);
			if (possible.includes(target)) records.push(...input(argument));
		}
		return records;
	}
	values(node: ts.Node, seen = new Set<ts.Node>()): { value: string; origin: ts.Node }[] {
		const target = this.resolve(node);
		if (!target || seen.has(target)) return [];
		seen.add(target);
		if (ts.isStringLiteralLike(target)) return [{ value: target.text, origin: target }];
		if (ts.isCallExpression(target) && this.defineCall(target)) {
			const name = target.arguments[0]; return name ? this.values(name, seen).map((row) => ({ ...row, origin: target })) : [];
		}
		if (ts.isObjectLiteralExpression(target)) {
			const name = target.properties.find((property) => property.name?.getText() === "name");
			if (name && ts.isPropertyAssignment(name)) return this.values(name.initializer, seen).map((row) => ({ ...row, origin: target }));
			if (name && ts.isShorthandPropertyAssignment(name)) {
				const declaration = this.checker.getShorthandAssignmentValueSymbol(name)?.valueDeclaration;
				if (declaration && (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration))) return this.values(declaration.name, seen).map((row) => ({ ...row, origin: target }));
			}
		}
		if (ts.isParameter(target)) {
			const owner = target.parent;
			if (!isFunction(owner)) return [];
			const index = owner.parameters.indexOf(target);
			return this.calls.flatMap((call) => {
				if (!this.path(call) || !(this.targets.get(call)?.has(owner) || this.callTarget(call) === owner)) return [];
				const argument = call.arguments[index]; return argument ? this.values(argument, new Set(seen)) : [];
			});
		}
		return [];
	}
	defineCall(node: ts.CallExpression): boolean {
		const target = this.resolve(node.expression);
		if (!target || !isFunction(target) || target.name?.getText() !== "define") return false;
		let parent: ts.Node | undefined = target.parent;
		while (parent && !ts.isModuleDeclaration(parent)) parent = parent.parent;
		return !!parent && ts.isModuleDeclaration(parent) && parent.name.text === "BusEvent";
	}
	carries(node: ts.Node, parameter: ts.ParameterDeclaration, seen = new Set<ts.Node>()): boolean {
		if (seen.has(node) || isFunction(node)) return false;
		seen.add(node);
		const declaration = this.declaration(node);
		if (declaration === parameter) return true;
		if (declaration && ts.isParameter(declaration) && isFunction(declaration.parent)) {
			const owner = declaration.parent, index = owner.parameters.indexOf(declaration);
			for (const call of this.calls) {
				const argument = call.arguments[index];
				if (argument && this.path(call) && this.targets.get(call)?.has(owner) && this.carries(argument, parameter, new Set(seen))) return true;
			}
		}
		if (declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) && declaration.initializer && this.carries(declaration.initializer, parameter, seen)) return true;
		let found = false;
		ts.forEachChild(node, (child) => { if (this.carries(child, parameter, seen)) found = true; });
		return found;
	}
	exceptional(node: ts.Node): boolean {
		for (let parent = node.parent; parent && !isFunction(parent); parent = parent.parent) if (ts.isCatchClause(parent)) return true;
		return false;
	}
	descriptor(node: ts.ObjectLiteralExpression): boolean {
		const type = this.checker.getContextualType(node) ?? this.checker.getTypeAtLocation(node);
		return type.getSymbol()?.name === "Descriptor" && node.properties.some((property) => property.name?.getText() === "name") && node.properties.some((property) => property.name?.getText() === "schema");
	}
}
function publisherCensus(graph: Provenance) {
	const declarations = new Map<string, ts.Node>();
	const publishers = new Map<string, Edge[]>();
	for (const source of graph.sourceFiles) walk(source, (node) => {
		if (!(ts.isCallExpression(node) && graph.defineCall(node)) && !(ts.isObjectLiteralExpression(node) && graph.descriptor(node))) return;
		// The generic constructor body is forwarding, not a concrete schema.
		const owner = scope(node);
		if (isFunction(owner) && owner.name?.getText() === "define") return;
		const values = graph.values(node);
		if (!values.length) { graph.problem(node, "dynamic_event_declaration"); return; }
		for (const row of values) {
			const prior = declarations.get(row.value);
			if (prior && prior !== node) graph.problem(node, "conflicting_event_declaration");
			declarations.set(row.value, node);
		}
	});
	for (const call of graph.calls) {
		if (!graph.path(call)) continue;
		const implementations = graph.targets.get(call);
		const recordPublisherTarget = (target: ts.Node | undefined): void => {
			const name = target && (isFunction(target) || ts.isMethodSignature(target)) && target.name ? target.name.getText() : memberName(call.expression);
			if (name !== "publish") return;
			if (!target || ts.isMethodSignature(target) || ts.isPropertySignature(target)) { graph.problem(call, "unbound_publisher_port"); return; }
			const owners = new Set<ts.Node>([target]);
			for (const owner of owners) for (const invoked of graph.invokedWithin(owner)) owners.add(invoked);
			const inner = graph.calls.filter((candidate) => owners.has(scope(candidate)));
			if (inner.some((candidate) => scope(candidate) === target && memberName(candidate.expression) === "publish")) return;
			// Credit an observable transfer of the event, never merely a nonempty body.
			const parameter = isFunction(target) ? target.parameters[0] : undefined;
			const terminal = inner.find((operation) => {
				if (!parameter || !graph.path(operation) || graph.exceptional(operation)) return false;
				const receiver = ts.isPropertyAccessExpression(operation.expression) ? operation.expression.expression : undefined;
				const name = memberName(operation.expression), owner = graph.nativeOwner(operation);
				if (receiver && name === "push" && ts.isObjectLiteralExpression(target.parent)) {
					const collected = graph.declaration(receiver);
					const exposesCollection = target.parent.properties.some((property) => {
						if (ts.isShorthandPropertyAssignment(property)) return graph.checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration === collected;
						return ts.isPropertyAssignment(property) && graph.declaration(property.initializer) === collected;
					});
					if (exposesCollection) return false;
				}
				const boundary = (/\/console\.d\.ts$|\/lib\.dom\.d\.ts$/.test(owner) && ["log", "info", "warn", "error"].includes(name))
					|| (!!receiver && graph.checker.isArrayType(graph.checker.getTypeAtLocation(receiver)) && name === "push");
				return boundary && operation.arguments.some((argument) => graph.carries(argument, parameter));
			});
			if (!terminal) return;
			const argument = call.arguments[0];
			const values = argument ? graph.publisherValues(call, target) : [];
			if (!values.length) { graph.problem(call, "dynamic_publisher"); return; }
			for (const row of values) {
				const edge = graph.edge(row.origin, terminal);
				if (!edge) continue;
				const list = publishers.get(row.value) ?? [];
				if (!list.some((item) => JSON.stringify(item) === JSON.stringify(edge))) list.push(edge);
				publishers.set(row.value, list);
			}

		};
		for (const target of implementations?.size ? implementations : [graph.callTarget(call)]) recordPublisherTarget(target);
	}
	const records = [...new Set([...declarations.keys(), ...publishers.keys()])].sort().map((name) => {
		const declaration = declarations.get(name);
		const edges = publishers.get(name) ?? [];
		return { name, definition: declaration ? graph.locus(declaration, name) : edges[0]?.terminalProductOperation, productionPublishers: edges, declared: !!declaration };
	});
	const findings: Finding[] = [];
	for (const record of records) if ((!record.declared || !record.productionPublishers.length) && record.definition) findings.push({ ...record.definition, symbol: record.name, class: "publisher" });
	return { records, findings };
}
function publicMap(graph: Provenance) {
	const uses = new Map<ts.Declaration, { consumers: Edge[]; aliases: Locus[] }>();
	const typeLinks: { from: ts.Declaration; to: ts.Declaration; site: ts.Node }[] = [];
	recordFunctionUses();
	for (const file of graph.sourceFiles) walk(file, (node) => {
		if (!ts.isIdentifier(node)) return;
		let declaration = graph.declaration(node);
		if (!declaration || node.parent === declaration) return;
		declaration = originalDeclaration(declaration);
		const row = uses.get(declaration) ?? { consumers: [], aliases: [] };
		uses.set(declaration, row);
		if (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent) || ts.isImportClause(node.parent)
			|| (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)
			|| ts.isShorthandPropertyAssignment(node.parent) || ts.isPropertyAssignment(node.parent)) {
			row.aliases.push(graph.locus(node)); return;
		}
		if (recordTypeLink(node, declaration)) return;
		if (node.getSourceFile() === declaration.getSourceFile()) return;
		const edge = graph.edge(declaration, node);
		if (edge) row.consumers.push(edge);
	});
	followTypeLinks();
	function followTypeLinks(): void {
	for (let changed = true; changed;) {
		changed = false;
		for (const link of typeLinks) {
			const source = uses.get(link.from);
			if (!source?.consumers.length) continue;
			const row = uses.get(link.to) ?? { consumers: [], aliases: [] };
			if (row.consumers.length) continue;
			row.consumers.push(...source.consumers.map((edge) => ({ ...edge, originDefinition: graph.locus(link.to), importOrAliasPath: [...edge.importOrAliasPath, graph.locus(link.site)] })));
			uses.set(link.to, row); changed = true;
		}
	}
	}

	function recordTypeLink(node: ts.Node, declaration: ts.Declaration): boolean {
		let owner: ts.Node | undefined = node.parent;
		while (owner && !ts.isSourceFile(owner) && !isFunction(owner) && !ts.isInterfaceDeclaration(owner) && !ts.isTypeAliasDeclaration(owner)) owner = owner.parent;
		if (owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner) || ts.isMethodSignature(owner))) {
			if (ts.isMethodSignature(owner)) {
				let enclosing: ts.Node | undefined = owner.parent;
				while (enclosing && !ts.isInterfaceDeclaration(enclosing)) enclosing = enclosing.parent;
				if (enclosing && ts.isInterfaceDeclaration(enclosing)) typeLinks.push({ from: enclosing, to: declaration, site: node });
			} else typeLinks.push({ from: owner, to: declaration, site: node });
			return true;
		}
		return false;
	}

	function originalDeclaration(initial: ts.Declaration): ts.Declaration {
		let declaration = initial;
		const seen = new Set<ts.Declaration>();
		while (ts.isVariableDeclaration(declaration) && declaration.initializer && !seen.has(declaration)) {
			seen.add(declaration);
			const initializer = unwrap(declaration.initializer);
			if (!ts.isIdentifier(initializer) && !ts.isPropertyAccessExpression(initializer)) break;
			const origin = graph.declaration(initializer);
			if (!origin) break;
			declaration = origin;
		}
		return declaration;
	}

	function recordFunctionUses(): void {
	for (const call of graph.calls) {
		if (!graph.path(call)) continue;
		for (const target of graph.targets.get(call) ?? []) {
			if (!isFunction(target)) continue;
			const edge = graph.edge(target, call);
			if (!edge || !edge.forwardingCallPath.some((site) => site.path !== graph.locus(target).path) && call.getSourceFile() === target.getSourceFile()) continue;
			const row = uses.get(target) ?? { consumers: [], aliases: [] }; row.consumers.push(edge); uses.set(target, row);
		}
	}
	}

	const records: { definition: Locus; consumers: Edge[]; aliases: Locus[] }[] = [];
	for (const source of graph.sourceFiles) {
		const module = graph.checker.getSymbolAtLocation(source);
		if (!module) continue;
		for (const exported of graph.checker.getExportsOfModule(module)) {
			const symbol = exported.flags & ts.SymbolFlags.Alias ? graph.checker.getAliasedSymbol(exported) : exported;
			const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
			if (!declaration) continue;
			const row = uses.get(declaration) ?? { consumers: [], aliases: [] };
			const root = graph.roots.get(resolve(source.fileName));
			if (exported.name === "default" && root?.symbol === "electron-vite") {
				const edge = graph.edge(declaration, declaration);
				if (edge) row.consumers.push({ ...edge, terminalProductOperation: root });
			}
			records.push({ definition: graph.locus(declaration, exported.name), ...row });
		}
	}
	return records;
}
function knipCensus(root: string, files: Entry[], roots: Map<string, Locus>, executable: string, topology: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "census-knip-"));
	try {
		const workspaces: Record<string, { entry: string[]; project: string[] }> = {};
		const dirs = topology ? [".", ...knipWorkspaces().map((row) => row.dir)] : ["."];
		for (const dir of dirs) {
			const owned = files.filter((row) => eligible(row) && (!topology || qualitySource(row.path)) && ["typescript", "javascript"].includes(row.language) && (dir === "." ? !topology || row.path.startsWith("script/") : row.path.startsWith(`${dir}/`)));
			workspaces[dir] = {
				entry: [...roots.keys()].filter((path) => owned.some((row) => resolve(root, row.path) === path)).map((path) => relative(resolve(root, dir), path)),
				project: owned.map((row) => relative(resolve(root, dir), resolve(root, row.path))),
			};
		}
		const config = join(dir, "knip.json");
		writeFileSync(config, JSON.stringify({ workspaces, ignore: files.filter((row) => !eligible(row)).map((row) => row.path) }));
		const result = runProductionKnip({ root, executable, config });
		if (!result.ok) fail(result.code, executable, result.message);
		const report = object(decode(result.stdout));
		const findings: Finding[] = [];
		const errors: Problem[] = [];
		function entries(value: Json, path: string, kind: string, parent = ""): void {
			if (Array.isArray(value)) { for (const item of value) entries(item, path, kind, parent); return; }
			const row = object(value);
			if (row.name === undefined) { for (const [name, value] of Object.entries(row)) entries(value, path, kind, name); return; }
			const name = kind === "files" ? "<file>" : string(row.name), line = typeof row.line === "number" ? row.line : 1;
			const locus = { path, line, symbol: parent ? `${parent}.${name}` : name };
			if (kind === "unresolved") errors.push({ ...locus, code: "unresolved_import" });
			else findings.push({ ...locus, class: "export" });
		}
		for (const value of array(report.issues)) {
			const row = object(value), path = string(row.file);
			for (const [kind, value] of Object.entries(row)) if (kind !== "file") entries(value, path, kind);
		}
		return { findings, errors };
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
function liveSchema(root: string, path: string, hash: string) {
	checked(root, path, hash);
	using db = new Database(sourcePath(root, path), { readonly: true });
	return liveCensusTables(db);
}
function storeCensus(graph: Provenance, tables: { name: string; sql: string }[]) {
	const migrations = graph.files.filter((row) => row.language === "sql" && row.category === "migration").map((row) => ({ path: row.path, sql: readFileSync(sourcePath(graph.root, row.path), "utf8") }));
	const origins = ledgerCensusSchemaOrigins(migrations);
	const records = tables.filter((table) => table.name !== "sqlite_sequence").map((table) => ({
		family: table.name, kind: "sqlite", liveTablesOrPathPattern: [table.name], definition: { path: origins.find((row) => row.family === table.name)?.path ?? "sqlite_schema", line: origins.find((row) => row.family === table.name)?.line ?? 1, symbol: table.name },
		schemaVersion: digest(table.sql), adapter: [...ledgerCensusOwner(table.name)], productionReads: [] as Edge[], productionWrites: [] as Edge[],
		forwardingPaths: [] as Locus[], archiveOnlyReferences: [] as Locus[], migrationOnlyReferences: [] as Locus[], retentionOwner: "unassigned", dispositionReceipt: null,
	}));
	const historicalReferences: { family: string; operation: Locus; role: string }[] = [];
	function storeReceiver(call: ts.CallExpression) {
		const receiver = ts.isPropertyAccessExpression(call.expression) ? graph.resolve(call.expression.expression) : undefined;
		const preparation = receiver && ts.isCallExpression(receiver) && ["query", "prepare"].includes(memberName(receiver.expression)) ? receiver : undefined;
		const bunFile = receiver && ts.isCallExpression(receiver) && memberName(receiver.expression) === "file" && /bun-types\//.test(graph.nativeOwner(receiver)) ? receiver : undefined;
		return { preparation, bunFile };
	}
	function nativeWrite(call: ts.CallExpression, native: string, name: string): boolean {
		const writeDeclaration = graph.resolve(call.expression);
		const bunWrite = /bun-types\//.test(native) && name === "write" && (!!writeDeclaration && ts.isFunctionDeclaration(writeDeclaration) || ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText() === "Bun");
		return bunWrite;
	}
	function storeOperation(call: ts.CallExpression) {
		const name = memberName(call.expression);
		if (!graph.path(call)) return undefined;
		const native = graph.nativeOwner(call);
		const sqlite = /bun-types\/sqlite\.d\.ts$/.test(native);
		const filesystem = /@types\/node\/fs(?:\/promises)?\.d\.ts$/.test(native) && ["writeFile", "writeFileSync", "readFile", "readFileSync", "appendFile", "appendFileSync"].includes(name);
		const { preparation, bunFile } = storeReceiver(call);
		const bunWrite = nativeWrite(call, native, name);
		if (!filesystem && !bunWrite && !bunFile && !(sqlite && ["exec", "run", "all", "get", "values", "iterate"].includes(name))) return undefined;
		if (bunFile && !["text", "json", "arrayBuffer", "bytes", "stream"].includes(name)) return undefined;
		const argument = preparation ? preparation.arguments[0] : bunFile ? bunFile.arguments[0] : call.arguments[0];
		if (!argument) return undefined;
		return { name, sqlite, bunFile, argument };
	}
	function recordUnresolvedStore(call: ts.CallExpression, sqlite: boolean, argument: ts.Expression): void {
		if (graph.role(call) === "migration") {
			// The existing ordered migration owner reads this canonical inventory's
			// SQL corpus. Record historical executions separately; never resurrect a
			// historical CREATE as a live store or a product consumer.
			for (const migration of migrations) historicalReferences.push({ family: migration.path, operation: graph.locus(call), role: sqlite ? "migration-execution" : "migration-source-read" });
			if (!migrations.length) graph.problem(call, "missing_migration_inputs", argument);
			return;
		}
		if (sqlite) {
			const owner = scope(call);
			const database = ts.isPropertyAccessExpression(call.expression) ? graph.resolve(call.expression.expression) : undefined;
			if (isFunction(owner) && ledgerCensusSchemaCompiler(graph.locus(owner, owner.name?.getText() ?? "")) && database && ts.isNewExpression(database) && database.arguments?.[0] && graph.strings(database.arguments[0]).some((row) => row.value === ":memory:")) {
				historicalReferences.push({ family: ":memory:", operation: graph.locus(call), role: "drizzle-schema-comparison" }); return;
			}
		}
		graph.problem(call, "dynamic_store_boundary", argument);

	}
	function recordSqlWrite(table: (typeof records)[number], sql: string, edge: Edge): void {
					const assigned = [...(sql.match(/\bSET\s+([\s\S]+?)(?:\bWHERE\b|$)/i)?.[1] ?? "").matchAll(/\b([a-z_]\w*)\s*=/gi)].map((match) => match[1] ?? "");
					const predicate = sql.match(/\bWHERE\s+([\s\S]+)/i)?.[1] ?? "";
					const guarded = assigned.some((column) => new RegExp(`\\b${column}\\s*(?:=|IS\\s)`, "i").test(predicate));
					table.productionWrites.push({ ...edge, operationKind: guarded ? "compare-and-swap" : /^\s*insert\b/i.test(sql) && !/\b(?:replace|conflict)\b/i.test(sql) ? "append" : /^\s*delete\b/i.test(sql) ? "delete" : "write" });
	}
	const recordStoreCall = (call: ts.CallExpression): void => {
		const operation = storeOperation(call);
		if (!operation) return;
		const { name, sqlite, bunFile, argument } = operation;
		const values = sqlite ? graph.sql(argument) : graph.strings(argument, true);
		if (!values.length) { recordUnresolvedStore(call, sqlite, argument); return; }
		const recordStoreValue = (row: { value: string; origin: ts.Node }): void => {
			if (!sqlite) {
				let table = records.find((record) => record.kind === "filesystem" && record.family === row.value);
				if (!table) {
					table = { family: row.value, kind: "filesystem", liveTablesOrPathPattern: [row.value], definition: graph.locus(row.origin, row.value), schemaVersion: digest(row.value), adapter: [graph.locus(call).path], productionReads: [], productionWrites: [], forwardingPaths: [], archiveOnlyReferences: [], migrationOnlyReferences: [], retentionOwner: "unassigned", dispositionReceipt: null };
					records.push(table);
				}
				const edge = graph.edge(row.origin, call);
				if (edge) {
					if (bunFile || name === "readFile" || name === "readFileSync") table.productionReads.push(edge);
					else table.productionWrites.push(edge);
					table.forwardingPaths.push(...edge.forwardingCallPath);
				}
				return;
			}
			const sql = row.value;
			const matches = [...sql.matchAll(/\b(from|join|into|update)\s+["`[]?([\w]+)["`\]]?/gi)];
			const recordSqlFamily = (match: RegExpMatchArray): void => {
				if (match[1]?.toLowerCase() === "update" && match[2]?.toLowerCase() === "set") return;
				const family = match[2] ?? "";
				if (family.includes("__CENSUS_DYNAMIC__")) { graph.problem(call, "dynamic_store_boundary"); return; }
				if (["sqlite_master", "sqlite_schema"].includes(family)) {
					historicalReferences.push({ family, operation: graph.locus(call), role: "schema-introspection" }); return;
				}
				const table = records.find((record) => record.family === family);
				if (!table) {
					if (origins.some((row) => row.family === family && row.dropped)) historicalReferences.push({ family, operation: graph.locus(call), role: "historical-schema" });
					else graph.problem(call, "unclassified_sql_family");
					return;
				}
				const locus = graph.locus(call);
				const path = graph.path(call);
				if (!path) return;
				table.forwardingPaths.push(...path.chain);
				const role = graph.role(call);
				if (role === "archive") { table.archiveOnlyReferences.push(locus); return; }
				if (role === "migration" && table.family !== "_migrations") { table.migrationOnlyReferences.push(locus); return; }
				// SQL capability definitions and registration alone do not suffice: a cross-file
				// invocation into the function containing the SQL must be reachable from a root.
				const terminal = path.chain.find((site) => site.path !== locus.path);
				if (!terminal) return;
				const edge = graph.edge(row.origin, call);
				if (!edge) return;
				if (/^(from|join)$/i.test(match[1] ?? "") && !/^\s*delete/i.test(sql)) table.productionReads.push(edge);
				else {
					recordSqlWrite(table, sql, edge);
				}

			};
			for (const match of matches) recordSqlFamily(match);

		};
		for (const row of values) recordStoreValue(row);

	};
	for (const call of graph.calls) recordStoreCall(call);
	const findings: Finding[] = records.filter((row) => !row.productionReads.length && !row.productionWrites.length).map((row) => ({ ...row.definition, class: "store" }));
	return { records, findings, historicalReferences };
}
function pythonCensus(graph: Provenance, embedded: Entry[], embeddedText: Map<string, string>, executable: string): Json {
	const invocations = new Map<string, { root: Locus; chain: Locus[] }>();
	for (const [path, root] of graph.roots) invocations.set(relative(graph.root, path), { root, chain: [] });
	function commandProperty(command: ts.ObjectLiteralExpression): ts.Node | undefined {
				const cmd = command.properties.find((property) => property.name && memberName(property.name) === "cmd");
				if (cmd && ts.isShorthandPropertyAssignment(cmd)) {
					const declaration = graph.checker.getShorthandAssignmentValueSymbol(cmd)?.valueDeclaration;
					return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer ? graph.resolve(declaration.initializer) ?? declaration.initializer : undefined;
				}return cmd && ts.isPropertyAssignment(cmd) ? graph.resolve(cmd.initializer) : undefined;
	}
	function knownNonPythonCommands(arrays: readonly (readonly ts.Expression[])[]): boolean {
		if (!arrays.length) return false;
		return arrays.every((array) => {
			const binary = array[0];
			if (!binary) return false;
			const names = graph.strings(binary);
			return names.length > 0 && names.every((row) => !/(?:^|\/)python(?:3(?:\.\d+)?)?$/.test(row.value));
		});
	}
	function pythonCommand(call: ts.CallExpression, owner: string) {
		let command = call.arguments[0] ? graph.resolve(call.arguments[0]) : undefined;
		let options = call.arguments[2] ? graph.resolve(call.arguments[2]) : undefined;
		let words: readonly ts.Expression[] = [];
		if (!/bun-types\//.test(owner)) {
			const arrays = call.arguments[1] ? graph.commandArrays(call.arguments[1]) : [];
			if (call.arguments[0]) words = [call.arguments[0], ...(arrays.length === 1 ? arrays[0] ?? [] : [])];
			return { words, options };
		}
		if (command && ts.isObjectLiteralExpression(command)) {
			options = command;
			command = commandProperty(command);
		} else options = call.arguments[1] ? graph.resolve(call.arguments[1]) : undefined;
		const arrays = command ? graph.commandArrays(command) : [];
		if (arrays.length === 1 && arrays[0]) words = arrays[0];
		else if (knownNonPythonCommands(arrays)) return undefined;
		return { words, options };
	}
	function pythonCwd(call: ts.CallExpression, options: ts.Node | undefined): string | undefined {
		let cwd = graph.root;
		if (options && ts.isObjectLiteralExpression(options)) {
			const property = options.properties.find((property) => property.name && memberName(property.name) === "cwd");
			if (property && ts.isPropertyAssignment(property)) {
				const directories = graph.strings(property.initializer, true);
				if (directories.length !== 1 || !directories[0] || /[$*]/.test(directories[0].value)) { graph.problem(call, "dynamic_process_cwd"); return; }
				cwd = resolve(graph.root, directories[0].value);
			}
		}
		return cwd;
	}
	function recordEmbeddedPython(code: ts.Expression | undefined, call: ts.CallExpression, path: { root: Locus; chain: Locus[] }): boolean {
		let identified = false;
				const value = code ? graph.resolve(code) : undefined;
				if (value && ts.isTaggedTemplateExpression(value) && ts.isNoSubstitutionTemplateLiteral(value.template)) {
					for (const [identity, text] of embeddedText) if (text === value.template.rawText && identity.startsWith(`${relative(graph.root, value.getSourceFile().fileName)}#`)) {
						invocations.set(identity, { root: path.root, chain: [...path.chain, graph.locus(call)] }); identified = true;
					}
				}
		return identified;
	}
	function recordPythonWords(call: ts.CallExpression, path: { root: Locus; chain: Locus[] }, words: readonly ts.Expression[], cwd: string): boolean {
		let identified = false;
		for (let index = 1; index < words.length; index++) {
			const word = words[index]; if (!word) continue;
			const values = graph.strings(word);
			if (values.length === 1 && values[0]?.value === "-c") {
				identified = recordEmbeddedPython(words[index + 1], call, path);
				break;
			}
			if (!values.length) break;
			if (values.every((row) => /^-(?:u|I|B|E|s|S|O|OO|q)$/.test(row.value))) continue;
			for (const value of values) {
				const identity = relative(graph.root, resolve(cwd, value.value));
				if (!graph.files.some((row) => row.path === identity && eligible(row) && row.language === "python")) { graph.problem(call, "unresolved_python_process_source", word); continue; }
				invocations.set(identity, { root: path.root, chain: [...path.chain, graph.locus(call)] }); identified = true;
			}
			break;
		}
		return identified;
	}
	const recordPythonInvocation = (call: ts.CallExpression): void => {
		const path = graph.path(call), owner = graph.nativeOwner(call), name = memberName(call.expression);
		if (!path || !/child_process\.d\.ts$|bun-types\//.test(owner) || !["spawn", "spawnSync", "execFile", "execFileSync"].includes(name)) return;
		const command = pythonCommand(call, owner);
		if (!command) return;
		const { words, options } = command;
		const binaries = words[0] ? graph.strings(words[0]) : [];
		if (!binaries.length) { graph.problem(call, "dynamic_process_command"); return; }
		if (!binaries.some((row) => /(?:^|\/)python(?:3(?:\.\d+)?)?$/.test(row.value))) return;
		const cwd = pythonCwd(call, options);
		if (cwd === undefined) return;
		const identified = recordPythonWords(call, path, words, cwd);
		if (!identified) graph.problem(call, "unresolved_python_process_source");

	};
	for (const call of graph.calls) recordPythonInvocation(call);
	const sources = [...graph.files, ...embedded].filter((row) => eligible(row) && row.language === "python").map((row) => {
		const text = embeddedText.get(row.path) ?? readFileSync(sourcePath(graph.root, row.path), "utf8");
		const operational = invocations.has(row.path);
		return { path: row.path, text, operational };
	});
	if (!sources.length) return { python: null, sources: [] };
	const script = join(import.meta.dir, "quality-census/python-provenance.py");
	const result = Bun.spawnSync([executable, "-I", script], { stdin: Buffer.from(JSON.stringify({ sources })), timeout: 30_000 });
	if (result.exitCode !== 0 && result.exitCode !== 2) fail("python_execution", script, result.stderr.toString());
	const report = object(decode(result.stdout.toString()));
	if (report.version !== 1 || report.python !== "3.13.15") fail("tool_version", executable, "Python 3.13.15 required");
	if (array(report.sources).length !== sources.length) fail("python_partial", script, "source coverage differs");
	const analyzed = array(report.sources).map((value) => {
		const row = object(value), path = string(row.path);
		for (const value of array(row.errors)) {
			const error = object(value);
			graph.errors.push({ path, line: typeof error.line === "number" ? error.line : 1, symbol: string(error.symbol), code: string(error.code) });
		}
		const invocation = invocations.get(path);
		return { ...row, rootInvocation: invocation ? { ...invocation.root } : null, forwardingCallPath: invocation?.chain.map((site) => ({ ...site })) ?? [] };
	});
	return { ...report, sources: analyzed, executable, analyzerSha256: digest(readFileSync(script)) };
}
function bytewise(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function locationOrder(a: Locus, b: Locus): number { return bytewise(a.path, b.path) || a.line - b.line || bytewise(a.symbol, b.symbol); }
function censusOptions(argv: string[]) {
		return parseArgs({
			args: argv, strict: true, options: {
				python: { type: "string", default: "python3" }, json: { type: "boolean" }, root: { type: "string", default: process.cwd() }, class: { type: "string" }, inventory: { type: "string" }, "inventory-sha256": { type: "string" }, contract: { type: "string" },
				knip: { type: "string" }, "knip-sha256": { type: "string" }, schema: { type: "string" }, "schema-sha256": { type: "string" }, "upgraded-schema": { type: "string" }, "upgraded-schema-sha256": { type: "string" },
			}
		}).values;
}
function censusInput(values: ReturnType<typeof censusOptions>): { root: string; selected: CensusClass; input: ReturnType<typeof loadInput> } {
		const root = realpathSync(values.root);
		const selected = values.class;
		if (selected !== "publisher" && selected !== "export" && selected !== "store") fail("missing_input", "class", "select publisher, export or store");
		if (!values.inventory || !values["inventory-sha256"] || !values.contract) fail("missing_input", "inventory", "frozen inventory, digest and contract required");
		const input = loadInput(root, values.inventory, values["inventory-sha256"], values.contract);
	return { root, selected, input };
}
export function censusMain(argv = Bun.argv.slice(2)): number {
	lastFailure = undefined;
	const jsonMode = argv.includes("--json");
	try {
		if (ts.version !== "5.9.2") fail("tool_version", "typescript", "requires 5.9.2");
		const values = censusOptions(argv);
		const { root, selected, input } = censusInput(values);
		const program = makeProgram(root, input.files, input.projects);
		const roots = productionRoots(root, input.files, input.topology);
		const graph = new Provenance(root, program, input.files, roots.entries, input.topology);
		if (input.topology) validateApplications(root, roots, graph);
		validateCallBoundaries(graph);
		let findings: Finding[] = [];
		let map: object = {};
		if (selected === "publisher") { const result = publisherCensus(graph); findings = result.findings; map = { schemas: result.records }; }
		({ findings, map } = exportResults(selected, values, root, input, roots, findings, graph, map));
		({ findings, map } = storeResults(selected, values, root, graph, input, findings, map));
		findings = [...new Map(findings.map((row) => [JSON.stringify(row), row])).values()];
		findings.sort((a, b) => bytewise(a.class, b.class) || locationOrder(a, b));
		graph.errors.sort((a, b) => locationOrder(a, b) || bytewise(a.code, b.code));
		const complete = graph.errors.length === 0;
		const document = {
			version: 1, class: selected, complete, inventoryHash: input.inventoryHash, contractHash: input.contractHash,
			tools: { bun: Bun.version, typescript: ts.version, knip: selected === "export" ? "6.31.0" : null, knipHash: values["knip-sha256"] ?? null }, roots: [...roots.entries].map(([path, invocation]) => ({ path: relative(root, path), invocation })), configurationHashes: roots.configurationHashes,
			counts: { publisher: 0, export: 0, store: 0, [selected]: findings.length }, analyzedClasses: [selected], findings, errors: graph.errors, aliases: graph.aliases, assets: graph.assets,
			dependencyContracts: Object.fromEntries(graph.dependencyContracts), invocations: [...graph.targets].filter(([call]) => !!graph.path(call)).map(([call, targets]) => ({ call: graph.locus(call), implementations: [...targets].map((target) => graph.locus(target, isFunction(target) ? target.name?.getText() ?? "<callback>" : target.getText())), root: graph.path(call)?.root })), ...map,
			externalEvents: [...graph.externalEvents].map(([registration, trigger]) => ({ registration: graph.locus(registration), ...trigger })),
		};
		if (jsonMode) console.log(JSON.stringify(document));
		else {
			for (const finding of findings) console.log(`${finding.class} ${finding.path}:${finding.line} ${finding.symbol}`);
			if (!complete) process.stderr.write(`${JSON.stringify({ errors: graph.errors })}\n`);
		}
		return complete ? findings.length ? 1 : 0 : 2;
	} catch {
		const failure = lastFailure ?? { code: "analysis_error", path: "", message: "input or analyzer failed" };
		const document = JSON.stringify({ version: 1, complete: false, counts: { publisher: 0, export: 0, store: 0 }, analyzedClasses: [], findings: [], errors: [failure] });
		if (jsonMode) console.log(document);
		else process.stderr.write(`${document}\n`);
		return 2;
	}

	function validateApplications(root: string, roots: ReturnType<typeof productionRoots>, graph: Provenance): void {
		for (const workspace of knipWorkspaces()) {
			if (workspace.dir.startsWith("apps/") && ![...roots.entries.keys()].some((path) => relative(root, path).startsWith(`${workspace.dir}/`)))
				graph.errors.push({ path: workspace.dir, line: 1, symbol: workspace.packageName, code: "unsupported_application_root" });
		}
	}

	function storeResults(selected: CensusClass, values: ReturnType<typeof censusOptions>, root: string, graph: Provenance, input: { files: Entry[]; projects: string[]; topology: boolean; embedded: Entry[]; embeddedText: Map<string, string>; inventoryHash: string; contractHash: string; }, previousFindings: Finding[], previousMap: object) {
		let findings = previousFindings;
		let map = previousMap;
		if (selected === "store") {
			if (!values.schema || !values["schema-sha256"] || !values["upgraded-schema"] || !values["upgraded-schema-sha256"]) fail("missing_input", "schema", "fresh and upgraded lifecycle databases with digests required");
			const fresh = liveSchema(root, values.schema, values["schema-sha256"]), upgraded = liveSchema(root, values["upgraded-schema"], values["upgraded-schema-sha256"]);
			if (!fresh.length || JSON.stringify(fresh) !== JSON.stringify(upgraded)) fail("schema_drift", "sqlite_schema", "fresh/upgraded schemas differ or empty");
			const result = storeCensus(graph, fresh);
			const python = pythonCensus(graph, input.embedded, input.embeddedText, values.python);
			for (const value of array(object(python).sources)) {
				const source = object(value), path = string(source.path);
				for (const value of array(source.boundaries)) attachBoundary(source, object(value), path);
			}
			function attachBoundary(source: { [key: string]: Json }, boundary: { [key: string]: Json }, path: string): void {
					const locus = { path, line: typeof boundary.line === "number" ? boundary.line : 1, symbol: string(boundary.symbol) };
					const kind = string(boundary.kind);
					const sql = typeof boundary.sql === "string" ? boundary.sql : "";
					const families = kind === "filesystem" ? [string(boundary.family)] : [...sql.matchAll(/\b(?:from|join|into|update)\s+["`[]?([\w]+)["`\]]?/gi)].map((match) => match[1] ?? "").filter((name) => name.toLowerCase() !== "set");
				for (const family of families) attachFamily(family, kind, sql, locus, path, source, boundary);
			}
			function attachFamily(family: string, kind: string, sql: string, locus: Locus, path: string, source: { [key: string]: Json }, boundary: { [key: string]: Json }): void {
						let store = result.records.find((row) => row.kind === kind && row.family === family);
						if (!store && kind === "sqlite") { graph.errors.push({ ...locus, code: "unclassified_python_sql_family" }); return; }
						if (!store) {
							store = { family, kind, liveTablesOrPathPattern: [family], definition: locus, schemaVersion: digest(family), adapter: [path], productionReads: [], productionWrites: [], forwardingPaths: [], archiveOnlyReferences: [], migrationOnlyReferences: [], retentionOwner: "unassigned", dispositionReceipt: null }; result.records.push(store);
						}
						const invocation = object(source.rootInvocation);
						const forwarding = array(source.forwardingCallPath).map((value) => {
							const site = object(value); return { path: string(site.path), line: typeof site.line === "number" ? site.line : 1, symbol: string(site.symbol) };
						});
						const edge = { originDefinition: locus, importOrAliasPath: [], forwardingCallPath: [...forwarding, ...array(boundary.forwardingLines).map((line) => ({ path, line: typeof line === "number" ? line : 1, symbol: "call" }))], terminalProductOperation: locus, rootInvocation: { path: string(invocation.path), line: typeof invocation.line === "number" ? invocation.line : 1, symbol: string(invocation.symbol) } };
						if (boundary.read === true || kind === "sqlite" && /^\s*(select|with)/i.test(sql)) store.productionReads.push(edge);
						if (boundary.write === true || kind === "sqlite" && /^\s*(insert|update|delete|replace)/i.test(sql)) store.productionWrites.push(edge);
			}

			findings = result.records.filter((row) => !row.productionReads.length && !row.productionWrites.length).map((row) => ({ ...row.definition, class: "store" }));
			map = { stores: result.records, structuralContracts: graph.structure(), intrinsicStores: fresh.filter((row) => /\bAUTOINCREMENT\b/i.test(row.sql)).map((row) => ({ family: "sqlite_sequence", maintainedFor: row.name, schemaVersion: digest(row.sql), consumerCredit: false })), historicalReferences: result.historicalReferences, python };
		}
		return { findings, map };
	}

	function exportResults(selected: CensusClass, values: ReturnType<typeof censusOptions>, root: string, input: { files: Entry[]; projects: string[]; topology: boolean; embedded: Entry[]; embeddedText: Map<string, string>; inventoryHash: string; contractHash: string; }, roots: { entries: Map<string, Locus>; configurationHashes: { path: string; sha256: string; }[]; }, previousFindings: Finding[], graph: Provenance, previousMap: object) {
		let findings = previousFindings;
		let map = previousMap;
		if (selected === "export") {
			if (!values.knip || !values["knip-sha256"]) fail("missing_input", "knip", "pinned executable and digest required");
			if (digest(readFileSync(resolve(values.knip))) !== values["knip-sha256"]) fail("tamper", values.knip, "Knip executable hash differs");
			const result = knipCensus(root, input.files, roots.entries, resolve(values.knip), input.topology);
			findings = result.findings; graph.errors.push(...result.errors);
			const publicSymbols = publicMap(graph);
			const missingConsumers = productionConsumerFindings(publicSymbols);
			for (const finding of missingConsumers) {
				if (!findings.some((row) => row.path === finding.path && (row.symbol === finding.symbol || row.symbol === "<file>"))) findings.push(finding);
			}
			map = { publicSymbols };
		}
		return { findings, map };
	}

	function validateCallBoundaries(graph: Provenance) {
		for (const call of graph.calls) {
			if (!graph.path(call)) continue;
			for (const argument of call.arguments) {
				const callback = graph.resolve(argument);
				const targets = graph.targets.get(call);
				if (callback && implementation(callback) && !graph.reachable.has(callback) && !targets?.size && !graph.registeredCallbacks.has(argument) && !ts.isParameter(graph.resolve(call.expression) ?? call)) graph.problem(call, "unresolved_callback_edge");
			}
			if (call.expression.kind === ts.SyntaxKind.ImportKeyword && !graph.moduleCalls.has(call) || memberName(call.expression) === "eval") graph.problem(call, "dynamic_module_boundary");
			if (ts.isElementAccessExpression(call.expression) && !ts.isStringLiteralLike(call.expression.argumentExpression) && !graph.nativeOwner(call).includes("/node_modules/")) {
				const selector = call.expression.argumentExpression;
				const type = graph.checker.getTypeAtLocation(selector);
				const finite = (type.isUnion() ? type.types : [type]).every((part) => part.isStringLiteral() || part.isNumberLiteral());
				if (!finite) graph.problem(call, "dynamic_call_target");
			}
		}
	}
}
if (import.meta.main) process.exitCode = censusMain();
