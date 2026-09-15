import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parentPort, Worker } from "node:worker_threads";
import ts from "typescript";
import { diagnostics, executionTreeHash, inventoryCompilerOptions, type MutationError, programs, sha256 } from "./quality-mutation-input";

type Contract = Parameters<typeof programs>[1];
type Inventory = Parameters<typeof programs>[2];
export type CompilerRequest = {
  executionTreeSha256: string;
  candidateId: string;
  path: string;
  originalSha256: string;
  sourceSha256: string;
  content: string;
};
type Project = {
  project: string;
  roots: string[];
  options: ts.CompilerOptions;
  members: Set<string>;
  diagnostics: string[];
};
type ProjectProof = { project: string; mode: "frozen" | "cold" | "incremental"; rootsSha256: string; membershipSha256: string; diagnosticsSha256: string };
export type CompilerProof = Omit<CompilerRequest, "content"> & {
  kind: "persistent-compiler";
  compiler: string;
  compilerSha256: string;
  configurationSha256: string;
  diagnosticRoot: string;
  valid: boolean;
  diagnostics: string[];
  diagnosticsSha256: string;
  projects: ProjectProof[];
};
type Active = { key: string; builder: ts.SemanticDiagnosticsBuilderProgram; sources: Map<string, ts.SourceFile>; changed: string };
export const COMPILER_BATCH_SIZE = 8;
export function compilerProofMatches(request: CompilerRequest, result: CompilerProof): boolean {
  return result.candidateId === request.candidateId &&
    result.sourceSha256 === request.sourceSha256 &&
    result.executionTreeSha256 === request.executionTreeSha256 &&
    result.originalSha256 === request.originalSha256 && result.path === request.path;
}

function proof(project: Project, mode: ProjectProof["mode"]): ProjectProof {
  return {
    project: project.project, mode,
    rootsSha256: sha256(JSON.stringify(project.roots)),
    membershipSha256: sha256(JSON.stringify([...project.members].sort())),
    diagnosticsSha256: sha256(JSON.stringify(project.diagnostics)),
  };
}

// Owns a frozen execution tree. Only the supplied, hash-bound source is overlaid;
// test processes never run in this tree. The campaign verifies the tree again at
// completion. No watcher, mtime, workspace graph or inferred export signature.
export class FrozenMutationCompiler {
  private readonly root: string;
  private readonly native: Project[] = [];
  private readonly fallback: Project | undefined;
  private active: Active | undefined;
  private readonly configurationSha256: string;
  private readonly compilerSha256 = sha256(readFileSync(require.resolve("typescript")));

  constructor(directory: string, contract: Contract, private readonly inventory: Inventory, readonly identity: string) {
    const root = realpathSync(directory);
    this.root = root;
    if (executionTreeHash(root) !== identity) throw new Error("Compiler frozen execution identity mismatch");
    this.configurationSha256 = sha256(JSON.stringify({ contract, inventory }));
    this.verifyConfigurations();
    let index = 0;
    for (const program of programs(root, contract, inventory)) {
      const project = {
        project: contract.projects[index] ?? "inventory-fallback",
        roots: [...program.getRootFileNames()], options: program.getCompilerOptions(),
        members: new Set(program.getSourceFiles().map((source) => source.fileName)),
        diagnostics: diagnostics([program]),
      };
      if (index < contract.projects.length) this.native.push(project);
      else this.fallback = project;
      index++;
    }
    Bun.gc(true);
  }

  private verifyConfigurations(): void {
    for (const file of this.inventory.configurations)
      if (sha256(readFileSync(resolve(this.root, file.path))) !== file.sha256)
        throw new Error(`Compiler frozen configuration mismatch: ${file.path}`);
  }

  private compile(project: Project, roots: string[], request: CompilerRequest): { project: Project; mode: ProjectProof["mode"] } {
    const path = resolve(this.root, request.path);
    const key = JSON.stringify([project.project, roots]);
    if (this.active?.key !== key) {
      this.active = undefined;
      Bun.gc(true); // At most one retained checker, even across shared consumers.
    }
    const previous = this.active;
    const sources = previous?.sources ?? new Map<string, ts.SourceFile>();
    if (previous) sources.delete(previous.changed); // Restore the previous overlay.
    sources.delete(path);
    const host = ts.createIncrementalCompilerHost(project.options, {
      ...ts.sys,
      readFile: (name, encoding) => resolve(name) === path ? request.content : ts.sys.readFile(name, encoding),
    });
    host.getCurrentDirectory = () => this.root;
    const getSourceFile = host.getSourceFile;
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
      const cached = sources.get(name);
      if (cached && !shouldCreateNewSourceFile) return cached;
      const source = getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
      if (source) sources.set(name, source);
      return source;
    };
    const builder = ts.createSemanticDiagnosticsBuilderProgram(roots, project.options, host, previous?.builder);
    this.active = { key, builder, sources, changed: path };
    // Same diagnostic families and native ordering/deduplication as
    // getPreEmitDiagnostics; the builder owns semantic invalidation and caching.
    const errors = ts.sortAndDeduplicateDiagnostics([
      ...builder.getConfigFileParsingDiagnostics(), ...builder.getOptionsDiagnostics(),
      ...builder.getSyntacticDiagnostics(), ...builder.getGlobalDiagnostics(),
      ...builder.getSemanticDiagnostics(),
      ...(project.options.declaration ? builder.getDeclarationDiagnostics() : []),
    ]).map((diagnostic) => ts.formatDiagnostics([diagnostic], {
      getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
    }));
    const members = new Set(builder.getSourceFiles().map((source) => source.fileName));
    for (const name of sources.keys()) if (!members.has(name)) sources.delete(name);
    return { project: { ...project, roots, members, diagnostics: errors }, mode: previous ? "incremental" : "cold" };
  }

  check(request: CompilerRequest): CompilerProof {
    const result = this.checkBatch([request])[0];
    if (!result) throw new Error("Missing compiler proof");
    return result;
  }

  checkBatch(requests: CompilerRequest[]): CompilerProof[] {
    if (requests.length === 0 || requests.length > COMPILER_BATCH_SIZE) throw new Error("Invalid compiler batch size");
    this.verifyConfigurations();
    const checks: { request: CompilerRequest; path: string; projects: ProjectProof[]; errors: string[]; covered: Set<string> }[] = requests.map((request) => {
      const path = resolve(this.root, request.path);
      const local = relative(this.root, path);
      if (request.executionTreeSha256 !== this.identity || isAbsolute(local) || local === ".." || local.startsWith("../"))
        throw new Error("Compiler request frozen identity mismatch");
      const original = this.inventory.files.find((file) => file.path === request.path);
      if (!original || original.sha256 !== request.originalSha256 || sha256(readFileSync(path)) !== request.originalSha256 || sha256(request.content) !== request.sourceSha256)
        throw new Error("Compiler request source identity mismatch");
      return { request, path, projects: [], errors: [], covered: new Set<string>() };
    });
    // Keep one project active across the bounded batch, then release it before
    // the next project. Shared sources no longer force a cold build per mutant.
    for (const baseline of this.native) {
      const frozenProof = proof(baseline, "frozen");
      for (const state of checks) {
        const checked = baseline.members.has(state.path) ? this.compile(baseline, baseline.roots, state.request) : { project: baseline, mode: "frozen" as const };
        state.projects.push(checked.mode === "frozen" ? frozenProof : proof(checked.project, checked.mode));
        state.errors.push(...checked.project.diagnostics);
        for (const member of checked.project.members) state.covered.add(member);
      }
    }
    for (const state of checks) {
      const roots = this.inventory.files.filter((file) => ["typescript", "javascript"].includes(file.language))
        .map((file) => resolve(this.root, file.path)).filter((name) => !state.covered.has(name));
      if (roots.length) {
        const baseline = this.fallback ?? {
          project: "inventory-fallback", roots: [], members: new Set<string>(), diagnostics: [],
          options: inventoryCompilerOptions(this.root),
        };
        const checked = baseline.members.has(state.path) || JSON.stringify(roots) !== JSON.stringify(baseline.roots)
          ? this.compile(baseline, roots, state.request) : { project: baseline, mode: "frozen" as const };
        state.projects.push(proof(checked.project, checked.mode));
        state.errors.push(...checked.project.diagnostics);
      }
    }
    return checks.map(({ request, projects, errors }) => ({
      kind: "persistent-compiler", compiler: ts.version, compilerSha256: this.compilerSha256,
      configurationSha256: this.configurationSha256, diagnosticRoot: this.root,
      executionTreeSha256: this.identity, candidateId: request.candidateId, path: request.path,
      originalSha256: request.originalSha256, sourceSha256: request.sourceSha256,
      valid: errors.length === 0, diagnostics: errors, diagnosticsSha256: sha256(JSON.stringify(errors)), projects,
    }));
  }
}

type Initialize = { kind: "initialize"; root: string; contract: Contract; inventory: Inventory; identity: string };
type Request = Initialize | { kind: "check"; requests: CompilerRequest[] };
type Response = { kind: "ready" } | { kind: "checked"; proofs: CompilerProof[] } | { kind: "error"; message: string };

// One sequential worker per campaign, not independent processes per mutant.
// Worker errors/exits/timeouts permanently poison this client and are awaited
// through terminate(), so no compiler can outlive execution-copy cleanup.
export class MutationCompilerWorker {
  get identity(): string { return this.compilerIdentity; }
  private readonly worker = new Worker(new URL(import.meta.url));
  private ready: Promise<Response> | undefined;
  private pending: { resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  private closing: Promise<number> | undefined;
  closed = false;

  constructor(private readonly root: string, private readonly contract: Contract, private readonly inventory: Inventory, private readonly compilerIdentity: string, private readonly timeout: number) {
    this.worker.on("message", (response: Response) => {
      if (response.kind === "error") { this.abort(new Error(response.message)); return; }
      const pending = this.pending;
      if (!pending) { this.abort(new Error("Unexpected compiler response")); return; }
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(response);
    });
    this.worker.on("error", (error: Error) => this.abort(error));
    this.worker.on("exit", (code: number) => this.abort(new Error(`Compiler worker exited: ${code}`)));
  }

  private send(request: Request): Promise<Response> {
    if (this.closed || this.pending) return Promise.reject(new Error("Compiler worker unavailable"));
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => this.abort(new Error("Compiler worker timeout")), this.timeout);
      this.pending = { resolve: resolveResponse, reject, timer };
      this.worker.postMessage(request);
    });
  }

  private abort(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    this.closed = true;
    this.closing ??= this.worker.terminate();
    if (pending) {
      clearTimeout(pending.timer);
      void this.closing.then(() => pending.reject(error), () => pending.reject(error));
    }
  }

  async check(request: CompilerRequest): Promise<CompilerProof> {
    const proof = (await this.checkBatch([request]))[0];
    if (!proof) throw new Error("Missing compiler proof");
    return proof;
  }

  async checkBatch(requests: CompilerRequest[]): Promise<CompilerProof[]> {
    this.ready ??= this.send({ kind: "initialize", root: this.root, contract: this.contract, inventory: this.inventory, identity: this.compilerIdentity });
    const ready = await this.ready;
    if (ready.kind !== "ready") throw new Error("Missing compiler initialization proof");
    const response = await this.send({ kind: "check", requests });
    if (response.kind !== "checked" || response.proofs.length !== requests.length || response.proofs.some((proof, index) => {
      const request = requests[index];
      return !request || !compilerProofMatches(request, proof);
    })) {
      this.abort(new Error("Compiler response identity mismatch"));
      throw new Error("Compiler response identity mismatch");
    }
    return response.proofs;
  }

  async close(): Promise<void> {
    this.abort(new Error("Compiler worker disposed"));
    await this.closing;
  }
}

export function serveCompiler(port: {
  on(event: "message", receive: (request: Request) => void): void;
  postMessage(response: Response): void;
}): void {
  let compiler: FrozenMutationCompiler | undefined;
  async function receive(request: Request): Promise<Response> {
    if (request.kind === "initialize") {
      compiler = new FrozenMutationCompiler(request.root, request.contract, request.inventory, request.identity);
      return { kind: "ready" };
    }
    if (!compiler) throw new Error("Compiler worker not initialized");
    return { kind: "checked", proofs: compiler.checkBatch(request.requests) };
  }
  port.on("message", (request) => {
    void receive(request).then(
      (response) => port.postMessage(response),
      (error: Error | MutationError) => port.postMessage({ kind: "error", message: error.message }),
    );
  });
}
if (parentPort) serveCompiler(parentPort);
