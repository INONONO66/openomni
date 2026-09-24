import { expect, test } from "bun:test";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const header = `import { Context, Effect, Layer } from "effect";
import { bundle, compose, bundlePolicyTag } from "../packages/agent/src/bundle";
class A extends Context.Tag("@openomni/bundle/a/Value")<A, number>() {}
class B extends Context.Tag("@openomni/bundle/b/Value")<B, string>() {}
class External extends Context.Tag("@openomni/test/External")<External, boolean>() {}
const ALive = Layer.succeed(A, 7);
const BLive = Layer.effect(B, Effect.map(A, String));
const a = bundle({name:"a", requires:[], provides:[A], layer:ALive});
const b = bundle({name:"b", requires:[A], provides:[B], layer:BLive});
const seed = {requires:[], provides:[], layer:Layer.empty} as const;
`;
const positive = `${header}
const ExternalSeed = Layer.effect(A, Effect.flatMap(External, value => value ? Effect.succeed(7) : Effect.fail("seed-error" as const)));
const composed = compose({requires:[External], provides:[A], layer:ExternalSeed}, [b]);
type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const output: Equal<Layer.Layer.Success<typeof composed>, A | B> = true;
const input: Equal<Layer.Layer.Context<typeof composed>, External> = true;
const error: Equal<Layer.Layer.Error<typeof composed>, "seed-error" | import("../packages/agent/src/errors").BundleError> = true;
const tuple: Equal<typeof a.provides, readonly [typeof A]> = true;
const original: Equal<typeof a.layer, typeof ALive> = true;
const ObserverLive = Layer.scopedDiscard(Effect.asVoid(B));
const observer = bundle({name:"observer",requires:[B],provides:[],layer:ObserverLive});
const complete = compose(seed,[a,b,observer]);
const result = Effect.runPromise(Effect.all([A,B]).pipe(Effect.provide(complete)));
`;
const negatives = [
  ["output mismatch", `bundle({name:"a",requires:[],provides:[B],layer:ALive});`, 2554],
  ["input mismatch", `bundle({name:"b",requires:[],provides:[B],layer:BLive});`, 2554],
  ["identity-only forged Tag", `bundle({name:"a",requires:[],provides:[{key:A.key,_op:"Tag"}],layer:ALive});`, 2554],
  ["later provider", `compose(seed,[b,a]);`, 2554],
  ["missing provider", `compose(seed,[b]);`, 2554],
  ["wrong service value", `Layer.succeed(A,"wrong");`, 2345],
  ["unprovided Effect", `Effect.runPromise(A);`, 2345],
  ["dropped seed environment", `const SeedLive = Layer.effect(A,Effect.map(External,()=>7)); const live = compose({requires:[External],provides:[A],layer:SeedLive},[b]); const closed: Layer.Layer<A|B,import("../packages/agent/src/errors").BundleError> = live;`, 2322],
  ["reserved policy shape", `class InvalidPolicy extends Context.Tag("@openomni/bundle/b/Policy")<InvalidPolicy, number>() {} const live = Layer.succeed(InvalidPolicy,1); bundle({name:"b",requires:[],provides:[InvalidPolicy],layer:live});`, 2554],
  ["seed output mismatch", `compose({requires:[],provides:[B],layer:ALive},[]);`, 2554],
  ["seed input mismatch", `compose({requires:[],provides:[B],layer:BLive},[]);`, 2554],
] as const;

test("bundle compiler contract retains exact types and rejects metadata and environment mismatches", () => {
  const fixtures = new Map<string, string>([[resolve(root, "script/bundle-positive.fixture.ts"), positive], ...negatives.map(([name, code]) => [resolve(root, `script/bundle-${name.replaceAll(" ", "-")}.fixture.ts`), `${header}${code}`] as const)]);
  const options: ts.CompilerOptions = { strict: true, noUncheckedIndexedAccess: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, types: ["bun"] };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (file) => fixtures.get(file) ?? read(file);
  host.fileExists = (file) => fixtures.has(file) || exists(file);
  const program = ts.createProgram([...fixtures.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const owned = diagnostics.filter((item) => item.file?.fileName === resolve(root, "packages/agent/src/bundle.ts") || item.file?.fileName.endsWith("bundle-positive.fixture.ts"));
  expect(owned.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
  for (const [name, , code] of negatives) {
    const path = resolve(root, `script/bundle-${name.replaceAll(" ", "-")}.fixture.ts`);
    const failures = diagnostics.filter((item) => item.file?.fileName === path);
    expect(failures.map((item) => item.code), name).toEqual([code]);
    expect(failures.every((item) => item.start !== undefined && item.start >= header.length), name).toBe(true);
  }
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(resolve(root, "script/bundle-positive.fixture.ts"));
  if (!source) throw new Error("compiler fixture missing");
  const tops: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isCallExpression(node)) {
      const type = checker.getTypeAtLocation(ts.isVariableDeclaration(node) ? node.name : node);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) tops.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(tops).toEqual([]);
}, 15000);
