import { expect, test } from "bun:test";
import aiPackage from "ai/package.json";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { censusMain } from "./check-census";

const cli = join(import.meta.dir, "check-census.ts");
const knip = resolve(import.meta.dir, "../node_modules/knip/bin/knip.js");
function hash(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "census-fixture-"));
  readonly sources: Record<string, string>;
  constructor(sources: Record<string, string>) {
    this.sources = sources;
    this.write("package.json", JSON.stringify({ name: "census-fixture", private: true, scripts: { start: "bun src/main.ts" } }));
    this.write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "preserve", moduleResolution: "bundler", target: "esnext" }, include: ["src", "test"] }));
    for (const [path, content] of Object.entries(sources)) this.write(path, content);
    this.freeze();
  }
  write(path: string, content: string): void {
    mkdirSync(dirname(join(this.root, path)), { recursive: true }); writeFileSync(join(this.root, path), content);
  }
  freeze(omit: string[] = []): void {
    const contract = { version: 1, typescript: "5.9.2", roots: ["src", "test"], projects: ["tsconfig.json"], topology: false };
    this.write("contract.json", JSON.stringify(contract));
    this.write("inventory.json", JSON.stringify({ version: 1, contractHash: hash(JSON.stringify(contract)), files: Object.entries(this.sources).filter(([path]) => !omit.includes(path)).sort().map(([path, content]) => ({ path, sha256: hash(content), bytes: Buffer.byteLength(content), category: path.startsWith("test/") ? "test" : "production", language: path.endsWith(".py") ? "python" : path.endsWith(".js") ? "javascript" : "typescript" })), historical: [], embedded: [], configurations: [{ path: "tsconfig.json", sha256: hash(readFileSync(join(this.root, "tsconfig.json"))) }] }));
  }
  schema(sql = "CREATE TABLE item (id INTEGER PRIMARY KEY)"): string[] {
    for (const name of ["fresh.db", "upgraded.db"]) {
      using db = new Database(join(this.root, name)); db.exec(sql);
    }
    return ["--schema", "fresh.db", "--schema-sha256", hash(readFileSync(join(this.root, "fresh.db"))), "--upgraded-schema", "upgraded.db", "--upgraded-schema-sha256", hash(readFileSync(join(this.root, "upgraded.db")))];
  }
  run(kind: string, args: string[] = []) {
    const argv = ["--json", "--root", this.root, "--class", kind, "--contract", "contract.json", "--inventory", "inventory.json", "--inventory-sha256", hash(readFileSync(join(this.root, "inventory.json"))), "--knip", knip, "--knip-sha256", hash(readFileSync(knip)), ...args];
    const result = Bun.spawnSync([process.execPath, cli, ...argv], { cwd: this.root, timeout: 30_000 });
    const lines: string[] = [];
    const log = console.log;
    try {
      console.log = (line: string) => { lines.push(line); };
      expect(censusMain(argv)).toBe(result.exitCode);
      expect(`${lines.join("\n")}\n`).toBe(result.stdout.toString());
    } finally { console.log = log; }
    return { code: result.exitCode, output: result.stdout.toString(), stderr: result.stderr.toString() };
  }
  [Symbol.dispose](): void { rmSync(this.root, { recursive: true, force: true }); }
}
const protocol = `export namespace BusEvent {
  export interface Descriptor { name: string; schema: object }
  export function define(name: string, schema: object): Descriptor { return { name, schema }; }
}
export const Ready = BusEvent.define("ready", {});`;
const adapter = `import { Database } from "bun:sqlite";
const db = new Database(":memory:"); db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY)");
export function read() { return db.query("SELECT * FROM item").all(); }
export function write() { return db.query("INSERT INTO item VALUES (1)").run(); }`;

test("test-only consumption fails through the existing Knip owner", () => {
  using fixture = new Fixture({ "src/main.ts": "console.log('root');", "src/api.ts": "export const testOnly = 7;", "test/check.ts": 'import { testOnly } from "../src/api"; console.log(testOnly);' });
  const result = fixture.run("export");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"class":"export"');
  expect(result.output).toContain('"path":"src/api.ts"');
  expect(result.output).toContain('"complete":true');
}, 180_000);
test("real product export consumer passes, barrel-only forwarding fails", () => {
  using live = new Fixture({ "src/main.ts": 'import { value } from "./barrel"; console.log(value);', "src/barrel.ts": 'export { value } from "./api";', "src/api.ts": "export const value = 7;" });
  expect(live.run("export").code).toBe(0);
  using dead = new Fixture({ "src/main.ts": 'import "./barrel"; console.log("root");', "src/barrel.ts": 'export { value } from "./api";', "src/api.ts": "export const value = 7;" });
  expect(dead.run("export").code).toBe(1);
}, 180_000);
test("concrete schema with terminal publisher passes and missing publisher fails", () => {
  using live = new Fixture({ "src/events.ts": protocol, "src/main.ts": 'import { Ready } from "./events"; const sink = { publish(event: { name: string }, data: object) { console.log(event.name, data); } }; sink.publish(Ready, {});' });
  const result = live.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"name":"ready"');
  expect(result.output).toContain('"rootInvocation":');
  using dead = new Fixture({ "src/events.ts": protocol, "src/main.ts": 'import { Ready } from "./events"; console.log(Ready.name);' });
  const missing = dead.run("publisher");
  expect(missing.code).toBe(1);
  expect(missing.output).toContain('"publisher":1');
}, 180_000);
function assertPublication(fixture: Fixture, published: boolean): void {
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe(published ? '["ready"]' : '[]');
  expect(fixture.run("publisher").code).toBe(published ? 0 : 1);
}
test("nonempty no-op publisher differs from an actual event transfer", () => {
  for (const effectful of [false, true]) {
    using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import { Ready } from "./events"; const received:string[]=[]; const sink={publish(event:{name:string},data:object){${effectful ? "received.push(event.name);" : "return;"}}}; sink.publish(Ready,{}); console.log(JSON.stringify(received));` });
    assertPublication(fixture, effectful);
  }
}, 180_000);

test("test publishers, dormant publisher functions and noop sinks do not count", () => {
  for (const body of ["", "function dormant(){ sink.publish(Ready, {}); }", "sink.publish(Ready, {});"]) {
    using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import { Ready } from "./events"; const sink = { publish(event: {name: string}, data: object) {} }; ${body}`, "test/pub.ts": 'import { Ready } from "../src/events"; console.log(Ready);' });
    expect(fixture.run("publisher").code).toBe(1);
  }
}, 180_000);
test("reachable generic forwarder binds the concrete schema", () => {
  using fixture = new Fixture({ "src/events.ts": protocol, "src/forward.ts": 'export function forward(event: { name: string; schema: object }) { const sink = { publish(event: { name: string }, data: object) { console.log(event.name, data); } }; sink.publish(event, {}); }', "src/main.ts": 'import { Ready as Alias } from "./events"; import { forward } from "./forward"; forward(Alias);' });
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"forwardingCallPath":[{');
}, 180_000);
test("dynamic event name is analysis error rather than a clean census", () => {
  using fixture = new Fixture({ "src/events.ts": protocol.replace('"ready"', 'process.env.EVENT ?? "ready"'), "src/main.ts": 'import "./events";' });
  const result = fixture.run("publisher");
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"dynamic_event_declaration"');
}, 180_000);
test("real SQLite read OR write satisfies a live family, registration alone does not", () => {
  for (const operation of ["read", "write"]) {
    using fixture = new Fixture({ "src/adapter.ts": adapter, "src/main.ts": `import { ${operation} } from "./adapter"; console.log(${operation}());` });
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(0);
    expect(result.output).toContain(`"production${operation === "read" ? "Reads" : "Writes"}":[{`);
    expect(Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 }).exitCode).toBe(0);
  }
  using registered = new Fixture({ "src/adapter.ts": adapter, "src/main.ts": 'import { read } from "./adapter"; const registry = { read }; console.log(registry);' });
  const result = registered.run("store", registered.schema());
  expect(result.code).toBe(1);
  expect(result.output).toContain('"store":1');
}, 180_000);
test("preparation is not execution and operation filenames do not exclude consumers", () => {
  for (const execute of [false, true]) for (const entry of ["main", "storage-main", "migration-main", "archive-main"]) {
    using fixture = new Fixture({
      "src/adapter.ts": `import {Database} from "bun:sqlite"; export const db=new Database(":memory:"); db.exec("CREATE TABLE item(id INTEGER)"); export function write(){const statement=db.query("INSERT INTO item VALUES(1)");${execute ? 'statement.run();' : ''}}`,
      [`src/${entry}.ts`]: 'import {write} from "./adapter"; write();',
      "test/oracle.ts": 'import {db,write} from "../src/adapter"; write(); console.log(JSON.stringify(db.query("SELECT COUNT(*) AS n FROM item").get())); db.close();',
    });
    fixture.write("package.json", JSON.stringify({ name: "fixture", private: true, scripts: { start: `bun src/${entry}.ts` } }));
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "test/oracle.ts")], { timeout: 5000 });
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(execute ? '{"n":1}' : '{"n":0}');
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(execute ? 0 : 1);
    expect(result.output).toContain('"productionReads":[]');
    if (execute) expect(result.output).toContain('"terminalProductOperation":{"path":"src/adapter.ts","line":1,"symbol":"statement.run()"}');
  }
}, 180_000);

test("SQLite append and compare-and-swap operations retain distinct evidence", () => {
  using fixture = new Fixture({ "src/adapter.ts": 'import {Database} from "bun:sqlite";export const db=new Database(":memory:");db.exec("CREATE TABLE item(id INTEGER)");export function write(){db.query("INSERT INTO item VALUES(1)").run();db.query("UPDATE item SET id=2 WHERE id=1").run()}', "src/main.ts": 'import {db,write} from "./adapter";write();console.log(JSON.stringify(db.query("SELECT id FROM item").get()));' });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
  expect(actual.stdout.toString().trim()).toBe('{"id":2}');
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"operationKind":"append"');
  expect(result.output).toContain('"operationKind":"compare-and-swap"');
}, 180_000);

test("structural storage dispatch traces configure/get, factories and transactions", () => {
  using fixture = new Fixture({
    "src/adapter.ts": 'import {Database} from "bun:sqlite"; export const db=new Database(":memory:");db.exec("CREATE TABLE item(id INTEGER)");export interface Port {write():void};export function create():Port{return {write(){db.transaction(()=>db.query("INSERT INTO item VALUES(1)").run())()}}};let port:Port;export function configure(value:Port){port=value};export function get(){return port}',
    "src/main.ts": 'import {configure,create,get,db} from "./adapter"; configure(create()); get().write(); console.log(JSON.stringify(db.query("SELECT COUNT(*) AS n FROM item").get()));',
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('{"n":1}');
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"productionWrites":[{');
}, 180_000);

test("durable filesystem discovery and Python operations use real files and rows", () => {
  using files = new Fixture({ "src/main.ts": 'import {writeFileSync,readFileSync} from "node:fs"; import {join} from "node:path"; const path=join(import.meta.dir,"state.json"); writeFileSync(path,"sentinel"); console.log(readFileSync(path,"utf8"));' });
  const actual = Bun.spawnSync([process.execPath, join(files.root, "src/main.ts")], { timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(readFileSync(join(files.root, "src/state.json"), "utf8")).toBe("sentinel");
  const fileResult = files.run("store", files.schema());
  expect(fileResult.code).toBe(1); // Unconsumed item remains visible.
  expect(fileResult.output).toContain('"kind":"filesystem"');
  expect(fileResult.output).toContain('"family":"src/state.json"');
  using python = new Fixture({ "src/main.ts": 'console.log("typescript project");', "src/main.py": 'import sqlite3\ndb=sqlite3.connect(":memory:")\ndb.execute("CREATE TABLE item(id INTEGER)")\ndb.execute("INSERT INTO item VALUES(1)")\nprint(db.execute("SELECT COUNT(*) FROM item").fetchone()[0])\ndb.close()\n' });
  python.write("package.json", JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }));
  const executed = Bun.spawnSync(["python3", join(python.root, "src/main.py")], { timeout: 5000 });
  expect(executed.exitCode).toBe(0);
  expect(executed.stdout.toString().trim()).toBe("1");
  const result = python.run("store", python.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"python":"3.13.15"');
  expect(result.output).toContain('"productionWrites":[{');
}, 180_000);

test("Python syntax, dynamic SQL and missing runtime are analysis errors", () => {
  for (const source of ['def broken(:\n pass\n', 'import sqlite3,os\ndb=sqlite3.connect(":memory:")\ndb.execute(os.environ["SQL"])\n']) {
    using fixture = new Fixture({ "src/main.ts": 'console.log("project");', "src/main.py": source });
    fixture.write("package.json", JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }));
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(2);
    expect(result.output).toContain('"complete":false');
  }
  using fixture = new Fixture({ "src/main.ts": 'console.log("project");', "src/main.py": 'print(1)\n' });
  fixture.write("package.json", JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }));
  expect(fixture.run("store", [...fixture.schema(), "--python", join(fixture.root, "missing-python")]).code).toBe(2);
}, 180_000);

test("dynamic SQL and fresh/upgraded schema drift fail closed", () => {
  using dynamic = new Fixture({ "src/adapter.ts": adapter.replace('"SELECT * FROM item"', `\`SELECT * FROM \${process.env.TABLE}\``), "src/main.ts": 'import { read } from "./adapter"; read();' });
  expect(dynamic.run("store", dynamic.schema()).code).toBe(2);
  using drift = new Fixture({ "src/main.ts": 'console.log("root");' });
  const args = drift.schema();
  { using db = new Database(join(drift.root, "upgraded.db")); db.exec("CREATE TABLE extra (id INTEGER)"); }
  args[7] = hash(readFileSync(join(drift.root, "upgraded.db")));
  const result = drift.run("store", args);
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"schema_drift"');
}, 180_000);
test("CLI distinguishes missing input, tampering, incomplete inventory and syntax", () => {
  expect(Bun.spawnSync([process.execPath, cli], { timeout: 5000 }).exitCode).toBe(2);
  using fixture = new Fixture({ "src/main.ts": 'import { value } from "./api"; console.log(value);', "src/api.ts": "export const value = 1;" });
  fixture.write("src/api.ts", "export const value = 2;");
  expect(fixture.run("publisher").output).toContain('"code":"tamper"');
  fixture.write("src/api.ts", fixture.sources["src/api.ts"] ?? "");
  fixture.freeze(["src/api.ts"]);
  expect(fixture.run("publisher").output).toContain('"code":"incomplete_inventory"');
  using syntax = new Fixture({ "src/main.ts": "const = ;" });
  expect(syntax.run("publisher").output).toContain('"code":"unsupported_syntax"');
}, 180_000);
test("CLI rejects update instead of modifying frozen inputs", () => {
  using fixture = new Fixture({ "src/main.ts": 'console.log("root");' });
  const before = hash(readFileSync(join(fixture.root, "inventory.json")));
  expect(fixture.run("export", ["--update"]).code).toBe(2);
  expect(hash(readFileSync(join(fixture.root, "inventory.json")))).toBe(before);
}, 180_000);

test("descriptor objects, aliases, bind and destructuring keep terminal provenance", () => {
  for (const invoke of ["sink.publish(Ready, {});", "const emit = sink.publish; emit(Ready, {});", "const emit = sink.publish.bind(sink); emit(Ready, {});", "const { publish: emit } = sink; emit(Ready, {});"]) {
    using fixture = new Fixture({ "src/events.ts": protocol.replace('BusEvent.define("ready", {})', '{ name: "ready", schema: {} }').replace("const Ready =", "const Ready: BusEvent.Descriptor ="), "src/main.ts": `import { Ready } from "./events"; const sink = { publish(event: { name: string }, data: object) { console.log(event.name, data); } }; ${invoke}` });
    const result = fixture.run("publisher");
    expect(result.code).toBe(0);
    expect(result.output).toContain('"importOrAliasPath":[{');
  }
}, 180_000);
test("undeclared publisher fails and dynamic computed dispatch is incomplete", () => {
  using undeclared = new Fixture({ "src/main.ts": 'const sink = { publish(event: {name:string}, data: object){ console.log(event, data); } }; sink.publish({name:"missing",schema:{}}, {});' });
  const missing = undeclared.run("publisher");
  expect(missing.code).toBe(1);
  expect(missing.output).toContain('"publisher":1');
  using dynamic = new Fixture({ "src/main.ts": 'const sink = { publish(event: object){console.log(event);} }; sink[process.env.METHOD ?? "publish"]({});' });
  expect(dynamic.run("publisher").output).toContain('"code":"dynamic_call_target"');
}, 180_000);
test("malformed inventory and missing store evidence cannot become zero", () => {
  using fixture = new Fixture({ "src/main.ts": 'console.log("root");' });
  expect(fixture.run("store").output).toContain('"code":"missing_input"');
  fixture.write("inventory.json", '{"version":1}');
  expect(fixture.run("publisher").output).toContain('"code":"schema"');
}, 180_000);

test("callbacks require invocation, including concrete interface dispatch", () => {
  for (const invokes of [false, true]) {
    using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import {Ready} from "./events";
      const received:string[]=[];
      interface Sink { publish(event:{name:string},data:object):void }
      function use(sink:Sink){sink.publish(Ready,{})}
      function run(callback:()=>void){${invokes ? "callback();" : "return;"}}
      const sink:Sink={publish(event,data){received.push(event.name)}};
      run(()=>use(sink)); console.log(JSON.stringify(received));` });
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invokes ? '["ready"]' : '[]');
    expect(fixture.run("publisher").code).toBe(invokes ? 0 : 1);
  }
}, 180_000);

test("real Bun socket callback is an invoked publisher, not registration", () => {
  using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import {Ready} from "./events";
    const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};
    let delivered!:()=>void; const signal=new Promise<void>(resolve=>{delivered=resolve});
    const listener=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(socket,data){sink.publish(Ready,{});socket.end();delivered()}}});
    const client=await Bun.connect({hostname:"127.0.0.1",port:listener.port,socket:{open(socket){socket.write("trigger")},data(){}}});
    await signal;client.end();listener.stop(true);console.log(JSON.stringify(received));` });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 10_000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("real AI SDK stream dispatch invokes the concrete tool callback", () => {
  expect(aiPackage.version).toBe("6.0.141");
  using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `
    import {streamText,jsonSchema} from "ai";
    import {MockLanguageModelV3} from "ai/test";
    import {Ready} from "./events";
    const received:string[]=[];
    const sink={publish(event:{name:string},data:object){received.push(event.name)}};
    const model=new MockLanguageModelV3({doStream:{stream:new ReadableStream({start(controller){
      controller.enqueue({type:"stream-start",warnings:[]});
      controller.enqueue({type:"tool-call",toolCallId:"call-1",toolName:"emit",input:"{}"});
      controller.enqueue({type:"finish",finishReason:{unified:"tool-calls",raw:"tool_calls"},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}});controller.close();
    }})}});
    const result=streamText({model,prompt:"execute",tools:{emit:{inputSchema:jsonSchema({type:"object",properties:{},additionalProperties:false}),execute:async()=>{sink.publish(Ready,{});return "done"}}}});
    await result.consumeStream();console.log(JSON.stringify(received));
  ` });
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(fixture.root, "node_modules"));
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 15_000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"ai":{"version":"6.0.141"');
}, 180_000);

test("shared forwarders do not credit a no-op argument from another invocation", () => {
  using fixture = new Fixture({ "src/events.ts": `${protocol}\nexport const Other=BusEvent.define("other",{});`, "src/main.ts": 'import {Ready,Other} from "./events";interface Sink{publish(event:{name:string},data:object):void} function send(sink:Sink,event:{name:string}){sink.publish(event,{})}const received:string[]=[];const noop:Sink={publish(){return}};const live:Sink={publish(event,data){received.push(event.name)}};send(noop,Ready);send(live,Other);console.log(JSON.stringify(received));' });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
  expect(actual.stdout.toString().trim()).toBe('["other"]');
  const result = fixture.run("publisher");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"publisher":1');
}, 180_000);

test("collectors and unreachable effects do not grant publisher credit", () => {
  for (const body of ['return; received.push(event.name);', 'if(false){received.push(event.name)}']) {
    using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){${body}}};sink.publish(Ready,{});console.log(JSON.stringify(received));` });
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
    expect(actual.stdout.toString().trim()).toBe("[]");
    expect(fixture.run("publisher").code).toBe(1);
  }
  using collector = new Fixture({ "src/events.ts": protocol, "src/main.ts": 'import {Ready} from "./events";const events:string[]=[];const sink={events,publish(event:{name:string},data:object){events.push(event.name)}};sink.publish(Ready,{});' });
  expect(collector.run("publisher").code).toBe(1);
}, 180_000);

test("Electron Vite roots include main, preload and HTML module entries", () => {
  using fixture = new Fixture({
    "src/electron.vite.config.ts": 'export default {main:{build:{lib:{entry:"main.ts"}}},preload:{build:{lib:{entry:"preload.ts"}}},renderer:{build:{rollupOptions:{input:"index.html"}}}};',
    "src/main.ts": 'console.log("main");',
    "src/preload.ts": 'console.log("preload");',
    "src/renderer.ts": 'console.log("renderer");',
  });
  fixture.write("package.json", JSON.stringify({ name: "fixture" }));
  fixture.write("src/package.json", JSON.stringify({ name: "application", scripts: { build: "electron-vite build" } }));
  fixture.write("src/index.html", '<script type="module" src="./renderer.ts"></script>');
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  for (const entry of ["main", "preload", "renderer"]) {
    expect(result.output).toContain(`"path":"src/${entry}.ts","invocation":`);
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, `src/${entry}.ts`)], { timeout: 5000 });
    expect(actual.stdout.toString().trim()).toBe(entry);
  }
  expect(result.output).toContain('"path":"src/index.html","sha256":');
}, 180_000);

test("JavaScript publishers and declaration-bound non-SQL query objects", () => {
  using javascript = new Fixture({ "src/events.ts": protocol, "src/main.js": 'import {Ready} from "./events.ts";const sink={publish(event,data){console.log(event.name)}};sink.publish(Ready,{})' });
  javascript.write("package.json", JSON.stringify({ name: "fixture", scripts: { start: "bun src/main.js" } }));
  expect(javascript.run("publisher").code).toBe(0);
  using impostor = new Fixture({ "src/main.ts": 'const db={query(sql:string){return {run(){return}}}};db.query("INSERT INTO item VALUES(1)").run();' });
  expect(impostor.run("store", impostor.schema()).code).toBe(1);
}, 180_000);

test("unbound ports fail closed while native scheduled callbacks are traced", () => {
  using port = new Fixture({ "src/events.ts": protocol, "src/main.ts": 'import { Ready } from "./events"; declare const sink: {publish(event: object, data: object):void}; sink.publish(Ready, {});' });
  const unbound = port.run("publisher");
  expect(unbound.code).toBe(2);
  expect(unbound.output).toContain('"code":"unbound_publisher_port"');
  using callback = new Fixture({ "src/main.ts": 'queueMicrotask(() => { console.log("callback"); });' });
  expect(callback.run("publisher").code).toBe(0);
}, 180_000);
test("Knip use without terminal provenance cannot silently pass registration", () => {
  using fixture = new Fixture({ "src/api.ts": 'export function read(){ return 1; }', "src/main.ts": 'import { read } from "./api"; const registry = { read }; console.log(registry);' });
  const result = fixture.run("export");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"symbol":"read","class":"export"');
}, 180_000);

test("R3 local events require matching receiver and a subsequent trigger", () => {
  for (const trigger of ['', 'other.emit("trigger");', 'emitter.emit("other");', 'emitter.emit("trigger");']) {
    using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import {EventEmitter} from "node:events";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};const emitter=new EventEmitter(),other=new EventEmitter();emitter.on("trigger",()=>sink.publish(Ready,{}));${trigger}console.log(JSON.stringify(received));` });
    const actual = Bun.spawnSync([process.execPath, "src/main.ts"], { cwd: fixture.root, timeout: 5000 });
    const invoked = trigger === 'emitter.emit("trigger");';
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invoked ? '["ready"]' : '[]');
    expect(fixture.run("publisher").code).toBe(invoked ? 0 : 1);
  }
}, 180_000);

test("R3 scheduled publication reaches the effect through helper parameters", () => {
  for (const effectful of [false, true]) {
    using fixture = new Fixture({ "src/events.ts": protocol, "src/main.ts": `import {Ready} from "./events";const received:string[]=[];function deliver(value:{name:string}){${effectful ? 'received.push(value.name)' : 'void value.name'}}const sink={publish(event:{name:string},data:object){queueMicrotask(()=>deliver(event))}};sink.publish(Ready,{});await new Promise<void>(resolve=>queueMicrotask(resolve));console.log(JSON.stringify(received));` });
    assertPublication(fixture, effectful);
  }
}, 180_000);

test("R3 Python thread start, inactive branches and cursors have separate effects", () => {
  for (const operation of ['thread', 'started', 'inactive', 'cursor', 'shadow']) {
    const source = `import sqlite3,threading\ndb=sqlite3.connect("state.db",check_same_thread=False)\ndb.execute("CREATE TABLE item(id INTEGER)")\n${{
      thread: 'def save():\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\nthread=threading.Thread(target=save)\n',
      started: 'def save():\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\nthread=threading.Thread(target=save)\nthread.start();thread.join()\n',
      inactive: 'if False:\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\n',
      cursor: 'cursor=db.cursor()\ncursor.execute("INSERT INTO item VALUES(1)")\ndb.commit()\n',
      shadow: 'def save():\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\ndef run():\n def save():\n  return\n save()\nrun()\n',
    }[operation] ?? ''}db.close()\n`;
    using fixture = new Fixture({ "src/main.ts": 'console.log("project")', "src/main.py": source });
    fixture.write("package.json", JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }));
    const actual = Bun.spawnSync(['python3', '-I', '-c', 'import runpy,sqlite3;runpy.run_path("src/main.py");db=sqlite3.connect("state.db");print(db.execute("SELECT COUNT(*) FROM item").fetchone()[0]);db.close()'], { cwd: fixture.root, timeout: 5000 });
    const invoked = operation === 'started' || operation === 'cursor';
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invoked ? '1' : '0');
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(invoked ? 0 : 1);
    expect(result.output).toContain('"productionReads":[]');
  }
}, 180_000);

test("R3 child Python source is rooted in its actual spawn invocation", () => {
  using fixture = new Fixture({ "src/main.ts": 'import {spawnSync} from "node:child_process";const child=spawnSync("python3",["src/worker.py"],{stdio:"inherit"});if(child.status!==0)throw new Error("child failed");', "src/worker.py": 'import sqlite3\ndb=sqlite3.connect("state.db")\ndb.execute("CREATE TABLE item(id INTEGER)")\ndb.cursor().execute("INSERT INTO item VALUES(1)")\ndb.commit()\ndb.close()\n' });
  const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  { using db = new Database(join(fixture.root, 'state.db'), { readonly: true }); expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM item').get()?.n).toBe(1); }
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"rootInvocation":{"path":"package.json"');
  expect(result.output).toContain('"forwardingCallPath":[{"path":"src/main.ts"');
}, 180_000);

test("R3 unresolved process source and cursor identity are errors, not clean", () => {
  using processFixture = new Fixture({ "src/main.ts": 'import {spawnSync} from "node:child_process";spawnSync("python3",[process.env.WORKER ?? "src/worker.py"]);', "src/worker.py": 'print(1)\n' });
  expect(processFixture.run("store", processFixture.schema()).code).toBe(2);
  using pythonFixture = new Fixture({ "src/main.ts": 'console.log("project")', "src/main.py": 'def save(cursor):\n cursor.execute("INSERT INTO item VALUES(1)")\nsave(globals()["cursor"])\n' });
  pythonFixture.write("package.json", JSON.stringify({ scripts: { start: 'python3 src/main.py' } }));
  const result = pythonFixture.run("store", pythonFixture.schema());
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"unresolved_python_sql_receiver"');
}, 180_000);

test("R3 real observation bus transfers through its scheduled delivery", () => {
  using fixture = new Fixture({
    'src/protocol.ts': readFileSync(resolve(import.meta.dir, '../packages/protocol/src/bus/index.ts'), 'utf8'),
    'src/bus.ts': readFileSync(resolve(import.meta.dir, '../packages/agent/src/observation/bus.ts'), 'utf8').replace('"@openomni/protocol"', '"./protocol"'),
    'src/events.ts': 'import {BusEvent} from "./protocol";import {z} from "zod";export const Ready=BusEvent.define("ready",z.object({}));',
    'src/main.ts': 'import {Bus} from "./bus";import {Ready} from "./events";const received:string[]=[];const signal=new Promise<void>(resolve=>{Bus.observe((event)=>{received.push(event.name);resolve()})});Bus.publish(Ready,{});await signal;Bus.reset();console.log(JSON.stringify(received));',
  });
  symlinkSync(resolve(import.meta.dir, '../node_modules'), join(fixture.root, 'node_modules'));
  const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  expect(fixture.run('publisher').code).toBe(0);
}, 180_000);

test("R3 removed listeners and untriggered abort controllers stay dormant", () => {
  for (const operation of ['removed', 'abort-dormant', 'abort-triggered']) {
    const trigger = operation === 'removed' ? 'const emitter=new EventEmitter();const callback=()=>sink.publish(Ready,{});emitter.on("trigger",callback);emitter.off("trigger",callback);emitter.emit("trigger");' : `const controller=new AbortController();controller.signal.addEventListener("abort",()=>sink.publish(Ready,{}));${operation === 'abort-triggered' ? 'controller.abort();' : ''}`;
    using fixture = new Fixture({ 'src/events.ts': protocol, 'src/main.ts': `import {EventEmitter} from "node:events";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};${trigger}console.log(JSON.stringify(received));` });
    const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
    const invoked = operation === 'abort-triggered';
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invoked ? '["ready"]' : '[]');
    expect(fixture.run('publisher').code).toBe(invoked ? 0 : 1);
  }
}, 180_000);

test("R3 an unthrown catch around a scheduled noop is not publication", () => {
  using fixture = new Fixture({ 'src/events.ts': protocol, 'src/main.ts': 'import {Ready} from "./events";const received:string[]=[];function deliver(operation:()=>void,eventName:string){try{operation()}catch{console.warn(eventName)}}const sink={publish(event:{name:string},data:object){queueMicrotask(()=>deliver(()=>{void event.name},event.name))}};sink.publish(Ready,{});await new Promise<void>(resolve=>queueMicrotask(resolve));console.log(JSON.stringify(received));' });
  const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('[]');
  expect(actual.stderr.toString()).toBe('');
  expect(fixture.run('publisher').code).toBe(1);
}, 180_000);

test("R3 process signal callbacks are rooted in an operating-system trigger", () => {
  using fixture = new Fixture({ 'src/events.ts': protocol, 'src/main.ts': 'import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};const signal=new Promise<void>(resolve=>process.once("SIGUSR2",()=>{sink.publish(Ready,{});resolve()}));process.kill(process.pid,"SIGUSR2");await signal;console.log(JSON.stringify(received));' });
  const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  const result = fixture.run('publisher');
  expect(result.code).toBe(0);
  expect(result.output).toContain('"events":["SIGUSR2"]');
}, 180_000);

test("R3 Bun process entry invokes the child publisher rather than only importing it", () => {
  using fixture = new Fixture({ 'src/events.ts': protocol, 'src/worker.ts': 'import {Ready} from "./events";const sink={publish(event:{name:string},data:object){console.log(event.name)}};if(import.meta.main)sink.publish(Ready,{});', 'src/main.ts': 'const child=Bun.spawnSync([process.execPath,"src/worker.ts"],{stdout:"inherit",stderr:"inherit"});if(child.exitCode!==0)throw new Error("child failed");' });
  const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('ready');
  expect(fixture.run('publisher').code).toBe(0);
}, 180_000);


test("R4 private process names and helper order require actual dispatch", () => {
  for (const live of [false, true]) for (const native of [false, true]) {
    const body = native
      ? `process.on("private-trigger",()=>sink.publish(Ready,{}));${live ? 'process.emit("private-trigger");' : ''}`
      : `const emitter=new EventEmitter();function attach(){emitter.on("trigger",()=>sink.publish(Ready,{}))}function register(){attach()}function fire(){emitter.emit("trigger")}${live ? 'register();fire();' : 'fire();register();'}`;
    using fixture = new Fixture({ 'src/events.ts': protocol, 'src/main.ts': `import {EventEmitter} from "node:events";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};${body}console.log(JSON.stringify(received));` });
    const actual = Bun.spawnSync([process.execPath, 'src/main.ts'], { cwd: fixture.root, timeout: 5000 });
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(live ? '["ready"]' : '[]');
    const result = fixture.run('publisher');
    expect(result.code).toBe(live ? 0 : 1);
    expect(result.output).toContain('"externalEvents":[]');
  }
}, 180_000);

test("R4 suspended Python construction and partial next do not execute later segments", () => {
  const bodies = [
    ['async def save():', 'value.close()', false],
    ['async def save():', 'asyncio.run(value)', true],
    ['def save():\n yield None', 'value.close()', false],
    ['def save():\n yield None', 'list(value)', true],
    ['def save():\n yield None', 'next(value);value.close()', false],
    ['def save():\n if False:\n  yield None', 'value.close()', false],
    ['def save():\n if False:\n  yield None', 'list(value)', true],
  ] as const;
  for (const [definition, driver, live] of bodies) {
    using fixture = new Fixture({ 'src/main.ts': 'console.log("project")', 'src/main.py': `import sqlite3,asyncio\ndb=sqlite3.connect("state.db")\ndb.execute("CREATE TABLE item(id INTEGER)")\n${definition}\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\nvalue=save()\n${driver}\ndb.close()\n` });
    fixture.write('package.json', JSON.stringify({ scripts: { start: 'python3 src/main.py' } }));
    const actual = Bun.spawnSync(['python3', 'src/main.py'], { cwd: fixture.root, timeout: 5000 });
    expect(actual.exitCode).toBe(0);
    { using db = new Database(join(fixture.root, 'state.db'), { readonly: true }); expect(db.query<{ n:number }, []>('SELECT COUNT(*) AS n FROM item').get()?.n).toBe(live ? 1 : 0); }
    const result = fixture.run('store', fixture.schema());
    expect(result.code).toBe(live ? 0 : 1);
    expect(result.output).toContain('"productionReads":[]');
  }
}, 180_000);

test("R4 dynamic native triggers and unmodeled consumers stay incomplete", () => {
  using event = new Fixture({ 'src/events.ts': protocol, 'src/main.ts': 'import {Ready} from "./events";const sink={publish(e:{name:string},data:object){console.log(e.name)}};process.on(process.env.EVENT ?? "private",()=>sink.publish(Ready,{}));' });
  expect(event.run('publisher').code).toBe(2);
  using python = new Fixture({ 'src/main.ts': 'console.log("project")', 'src/main.py': 'import sqlite3\ndb=sqlite3.connect("state.db")\ndef save():\n yield None\n db.execute("INSERT INTO item VALUES(1)")\nvalue=save()\nconsumer=globals()["consume"]\nconsumer(value)\n' });
  python.write('package.json', JSON.stringify({ scripts: { start: 'python3 src/main.py' } }));
  const result = python.run('store', python.schema());
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"unresolved_python_suspended_consumer"');
}, 180_000);


test("native exit listeners removed before termination do not publish", () => {
  for (const removed of [true, false]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";const received:string[]=[];const sink={publish(e:{name:string},data:object){received.push(e.name)}};const callback=()=>sink.publish(Ready,{});process.on("exit",callback);${removed ? 'process.off("exit",callback);' : ''}process.on("exit",()=>console.log(JSON.stringify(received)));`,
    });
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {timeout: 5000});
    expect(actual.exitCode).toBe(0);
    expect(actual.stderr.toString()).toBe("");
    expect(actual.stdout.toString().trim()).toBe(removed ? "[]" : '["ready"]');
    const result = fixture.run("publisher");
    expect(result.code).toBe(removed ? 1 : 0);
    expect(result.output).toContain('"complete":true');
  }
}, 180_000);

test("helper-created generators retain distinct advancement identities", () => {
  for (const same of [false, true]) {
    using fixture = new Fixture({
      "src/main.ts": 'console.log("project")',
      "src/main.py": `import sqlite3
db=sqlite3.connect("state.db")
db.execute("CREATE TABLE item(id INTEGER)")
def save():
 yield None
 db.execute("INSERT INTO item VALUES(1)")
 db.commit()
 yield None
def make():
 return save()
left=make()
right=make()
next(left)
next(${same ? "left" : "right"})
left.close()
right.close()
db.close()
`,
    });
    fixture.write("package.json", JSON.stringify({name:"fixture",private:true,scripts:{start:"python3 src/main.py"}}));
    const actual = Bun.spawnSync(["python3", "src/main.py"], {cwd:fixture.root,timeout:5000});
    expect(actual.exitCode).toBe(0);
    expect(actual.stderr.toString()).toBe("");
    using db = new Database(join(fixture.root, "state.db"), {readonly:true});
    expect(db.query<{n:number}, []>("SELECT COUNT(*) AS n FROM item").get()?.n).toBe(same ? 1 : 0);
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(same ? 0 : 1);
    expect(result.output).toContain('"complete":true');
  }
}, 180_000);


test("native composed abort signals retain controller provenance without inventing an abort", () => {
  for (const fired of [false, true]) {
    using fixture = new Fixture({"src/events.ts":protocol,"src/main.ts":`import {Ready} from "./events";const received:string[]=[];const controller=new AbortController();const signal=AbortSignal.any([controller.signal]);const sink={publish(e:{name:string},data:object){received.push(e.name)}};signal.addEventListener("abort",()=>sink.publish(Ready,{}));${fired ? "controller.abort();" : ""}console.log(JSON.stringify(received));`});
    const native=Bun.spawnSync([process.execPath,join(fixture.root,"src/main.ts")],{timeout:5000});
    expect(native.exitCode).toBe(0);
    expect(native.stdout.toString().trim()).toBe(fired ? '["ready"]' : '[]');
    const result=fixture.run("publisher");
    expect(result.code).toBe(fired ? 0 : 1);
    expect(result.output).toContain('"complete":true');
  }
},180_000);

test("extensionless dynamic source imports are resolved, not classified as dynamic code", () => {
  using fixture=new Fixture({"src/events.ts":protocol,"src/main.ts":'const {publish}=await import("./publisher");publish();',"src/publisher.ts":'import {Ready} from "./events";export function publish(){const sink={publish(e:{name:string},data:object){console.log(e.name)}};sink.publish(Ready,{})}'});
  expect(fixture.run("publisher").code).toBe(0);
},180_000);


test("native module interposition invokes the factory for an already imported module", () => {
  using fixture=new Fixture({"src/events.ts":protocol,"src/main.ts":`import * as modules from "node:module";import * as events from "node:events";import {Ready} from "./events";const moduleLoader:{createRequire(path:string):(id:string)=>{mock:{module(id:string,factory:()=>object):void}}}=modules;const {mock}=moduleLoader.createRequire(import.meta.url)("bun:test");const received:string[]=[];const sink={publish(e:{name:string},data:object){received.push(e.name)}};mock.module("node:events",()=>{sink.publish(Ready,{});return events});console.log(JSON.stringify(received));`});
  const native=Bun.spawnSync([process.execPath,join(fixture.root,"src/main.ts")],{timeout:5000});
  expect(native.exitCode).toBe(0);
  expect(native.stdout.toString().trim()).toBe('["ready"]');
  expect(fixture.run("publisher").code).toBe(0);
},180_000);
