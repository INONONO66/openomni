import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import aiPackage from "ai/package.json";
import ts from "typescript";
import { readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Fixture, protocol, adapter, assertPublication, assertStoreWrite, configureElectronFixture, hash, cli } from "./census-fixture";
import { censusMain, scope } from "./check-census";
import type { Problem } from "./check-census";
import {
  decodeJson,
  jsonArray,
  jsonBoolean,
  jsonNumber,
  jsonObject,
  jsonString,
} from "./quality-inventory";

test("scope owner cache reuses node identity without crossing lexical scopes", () => {
  const source = ts.createSourceFile("scopes.ts", "function first() { tick(); } function second() { tick(); }", ts.ScriptTarget.Latest, true);
  const owners = source.statements.filter(ts.isFunctionDeclaration);
  expect(owners).toHaveLength(2);
  for (const owner of owners) {
    const node = owner.body?.statements[0];
    if (!node) throw new Error("missing fixture statement");
    const parent = node.parent;
    let parentReads = 0;
    Object.defineProperty(node, "parent", { get: () => { parentReads++; return parent; } });
    expect(scope(node)).toBe(owner);
    expect(parentReads).toBe(1);
    expect(scope(node)).toBe(owner);
    expect(parentReads).toBe(1);
  }
});

test("adjacent listener removals preserve the unremoved publisher and call order", () => {
  using fixture = new Fixture({
    "src/events.ts": `${protocol}\nexport const Other = BusEvent.define("other", {});`,
    "src/main.ts": `import {EventEmitter} from "node:events";import {Ready,Other} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};const emitter=new EventEmitter();const removed=()=>sink.publish(Ready,{}),retained=()=>sink.publish(Other,{});emitter.on("trigger",removed);emitter.on("trigger",retained);emitter.off("trigger",removed);emitter.emit("trigger");emitter.off("trigger",retained);console.log(JSON.stringify(received));`,
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["other"]');
  const result = fixture.run("publisher");
  expect(result.code).toBe(1);
  const findings = jsonArray(jsonObject(decodeJson(result.output)).findings, jsonObject);
  expect(findings.map((finding) => jsonString(finding.symbol))).toEqual(["ready"]);
});

test("census entry runs in process against a fixture", () => {
  using fixture = new Fixture({
    "src/main.ts": 'import { Ready } from "./events"; console.log(Ready.name);',
    "src/events.ts": protocol,
  });
  expect(censusMain([
    "--json", "--root", fixture.root, "--class", "publisher",
    "--contract", "contract.json", "--inventory", "inventory.json",
    "--inventory-sha256", hash(readFileSync(join(fixture.root, "inventory.json"))),
  ])).toBe(1);
});

test("scoped census retains resolver inputs but reports only affected sources", () => {
  using fixture = new Fixture({
    "src/main.ts": 'import { Ready } from "./events"; console.log(Ready.name);',
    "src/events.ts": protocol,
    "src/api.ts": "export const unused = 7;",
  });
  fixture.write("plan.json", JSON.stringify({ version: 2, class: "desktop", qualityScope: ["src/main.ts"], projects: ["tsconfig.json"] }));
  expect(fixture.run("publisher").code).toBe(1);
  expect(fixture.run("publisher", ["--plan", "plan.json"]).code).toBe(0);
  expect(fixture.run("export", ["--plan", "plan.json"]).code).toBe(0);
  fixture.write("plan.json", JSON.stringify({ version: 2, class: "desktop", qualityScope: ["src/main.ts", "src/events.ts", "src/api.ts"], projects: ["tsconfig.json"] }));
  expect(fixture.run("publisher", ["--plan", "plan.json"]).code).toBe(1);
  expect(fixture.run("export", ["--plan", "plan.json"]).code).toBe(1);
}, 60_000);

test("test-only consumption fails through the existing Knip owner", () => {
  using fixture = new Fixture({
    "src/main.ts": "console.log('root');",
    "src/api.ts": "export const testOnly = 7;",
    "test/check.ts": 'import { testOnly } from "../src/api"; console.log(testOnly);',
  });
  const result = fixture.run("export");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"class":"export"');
  expect(result.output).toContain('"path":"src/api.ts"');
  expect(result.output).toContain('"complete":true');
}, 180_000);
test("real product export consumer passes, barrel-only forwarding fails", () => {
  using live = new Fixture({
    "src/main.ts": 'import { value } from "./barrel"; console.log(value);',
    "src/barrel.ts": 'export { value } from "./api";',
    "src/api.ts": "export const value = 7;",
  });
  expect(live.run("export").code).toBe(0);
  using dead = new Fixture({
    "src/main.ts": 'import "./barrel"; console.log("root");',
    "src/barrel.ts": 'export { value } from "./api";',
    "src/api.ts": "export const value = 7;",
  });
  expect(dead.run("export").code).toBe(1);
}, 180_000);
test("concrete schema with terminal publisher passes and missing publisher fails", () => {
  using live = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts":
      'import { Ready } from "./events"; const sink = { publish(event: { name: string }, data: object) { console.log(event.name, data); } }; sink.publish(Ready, {});',
  });
  const result = live.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"name":"ready"');
  expect(result.output).toContain('"rootInvocation":');
  using dead = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": 'import { Ready } from "./events"; console.log(Ready.name);',
  });
  const missing = dead.run("publisher");
  expect(missing.code).toBe(1);
  expect(missing.output).toContain('"publisher":1');
}, 180_000);
test("nonempty no-op publisher differs from an actual event transfer", () => {
  for (const effectful of [false, true]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import { Ready } from "./events"; const received:string[]=[]; const sink={publish(event:{name:string},data:object){${effectful ? "received.push(event.name);" : "return;"}}}; sink.publish(Ready,{}); console.log(JSON.stringify(received));`,
    });
    assertPublication(fixture, effectful);
  }
}, 180_000);

test("test publishers, dormant publisher functions and noop sinks do not count", () => {
  for (const body of [
    "",
    "function dormant(){ sink.publish(Ready, {}); }",
    "sink.publish(Ready, {});",
  ]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import { Ready } from "./events"; const sink = { publish(event: {name: string}, data: object) {} }; ${body}`,
      "test/pub.ts": 'import { Ready } from "../src/events"; console.log(Ready);',
    });
    expect(fixture.run("publisher").code).toBe(1);
  }
}, 180_000);
test("reachable generic forwarder binds the concrete schema", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/forward.ts":
      "export function forward(event: { name: string; schema: object }) { const sink = { publish(event: { name: string }, data: object) { console.log(event.name, data); } }; sink.publish(event, {}); }",
    "src/main.ts":
      'import { Ready as Alias } from "./events"; import { forward } from "./forward"; forward(Alias);',
  });
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"forwardingCallPath":[{');
}, 180_000);
test("dynamic event name is analysis error rather than a clean census", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol.replace('"ready"', 'process.env.EVENT ?? "ready"'),
    "src/main.ts": 'import "./events";',
  });
  const result = fixture.run("publisher");
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"dynamic_event_declaration"');
}, 180_000);
test("real SQLite read OR write satisfies a live family, registration alone does not", () => {
  for (const operation of ["read", "write"]) {
    using fixture = new Fixture({
      "src/adapter.ts": adapter,
      "src/main.ts": `import { ${operation} } from "./adapter"; console.log(${operation}());`,
    });
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(0);
    expect(result.output).toContain(`"production${operation === "read" ? "Reads" : "Writes"}":[{`);
    expect(
      Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], { timeout: 5000 })
        .exitCode,
    ).toBe(0);
  }
  using registered = new Fixture({
    "src/adapter.ts": adapter,
    "src/main.ts":
      'import { read } from "./adapter"; const registry = { read }; console.log(registry);',
  });
  const result = registered.run("store", registered.schema());
  expect(result.code).toBe(1);
  expect(result.output).toContain('"store":1');
}, 180_000);
test("preparation is not execution and operation filenames do not exclude consumers", () => {
  for (const execute of [false, true])
    for (const entry of ["main", "storage-main", "migration-main", "archive-main"]) {
      using fixture = new Fixture({
        "src/adapter.ts": `import {Database} from "bun:sqlite"; export const db=new Database(":memory:"); db.exec("CREATE TABLE item(id INTEGER)"); export function write(){const statement=db.query("INSERT INTO item VALUES(1)");${execute ? "statement.run();" : ""}}`,
        [`src/${entry}.ts`]: 'import {write} from "./adapter"; write();',
        "test/oracle.ts":
          'import {db,write} from "../src/adapter"; write(); console.log(JSON.stringify(db.query("SELECT COUNT(*) AS n FROM item").get())); db.close();',
      });
      fixture.write(
        "package.json",
        JSON.stringify({
          name: "fixture",
          private: true,
          scripts: { start: `bun src/${entry}.ts` },
        }),
      );
      const actual = Bun.spawnSync([process.execPath, join(fixture.root, "test/oracle.ts")], {
        timeout: 5000,
      });
      expect(actual.exitCode).toBe(0);
      expect(actual.stdout.toString().trim()).toBe(execute ? '{"n":1}' : '{"n":0}');
      const result = fixture.run("store", fixture.schema());
      expect(result.code).toBe(execute ? 0 : 1);
      expect(result.output).toContain('"productionReads":[]');
      if (execute)
        expect(result.output).toContain(
          '"terminalProductOperation":{"path":"src/adapter.ts","line":1,"symbol":"statement.run()"}',
        );
    }
}, 180_000);

test("SQLite append and compare-and-swap operations retain distinct evidence", () => {
  using fixture = new Fixture({
    "src/adapter.ts":
      'import {Database} from "bun:sqlite";export const db=new Database(":memory:");db.exec("CREATE TABLE item(id INTEGER)");export function write(){db.query("INSERT INTO item VALUES(1)").run();db.query("UPDATE item SET id=2 WHERE id=1").run()}',
    "src/main.ts":
      'import {db,write} from "./adapter";write();console.log(JSON.stringify(db.query("SELECT id FROM item").get()));',
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.stdout.toString().trim()).toBe('{"id":2}');
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"operationKind":"append"');
  expect(result.output).toContain('"operationKind":"compare-and-swap"');
}, 180_000);

test("structural storage dispatch traces configure/get, factories and transactions", () => {
  using fixture = new Fixture({
    "src/adapter.ts":
      'import {Database} from "bun:sqlite"; export const db=new Database(":memory:");db.exec("CREATE TABLE item(id INTEGER)");export interface Port {write():void};export function create():Port{return {write(){db.transaction(()=>db.query("INSERT INTO item VALUES(1)").run())()}}};let port:Port;export function configure(value:Port){port=value};export function get(){return port}',
    "src/main.ts":
      'import {configure,create,get,db} from "./adapter"; configure(create()); get().write(); console.log(JSON.stringify(db.query("SELECT COUNT(*) AS n FROM item").get()));',
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('{"n":1}');
  assertStoreWrite(fixture);
}, 180_000);

test("durable filesystem discovery and Python operations use real files and rows", () => {
  using files = new Fixture({
    "src/main.ts":
      'import {writeFileSync,readFileSync} from "node:fs"; import {join} from "node:path"; const path=join(import.meta.dir,"state.json"); writeFileSync(path,"sentinel"); console.log(readFileSync(path,"utf8"));',
  });
  const actual = Bun.spawnSync([process.execPath, join(files.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(readFileSync(join(files.root, "src/state.json"), "utf8")).toBe("sentinel");
  const fileResult = files.run("store", files.schema());
  expect(fileResult.code).toBe(1); // Unconsumed item remains visible.
  expect(fileResult.output).toContain('"kind":"filesystem"');
  expect(fileResult.output).toContain('"family":"src/state.json"');
  using python = new Fixture({
    "src/main.ts": 'console.log("typescript project");',
    "src/main.py":
      'import sqlite3\ndb=sqlite3.connect(":memory:")\ndb.execute("CREATE TABLE item(id INTEGER)")\ndb.execute("INSERT INTO item VALUES(1)")\nprint(db.execute("SELECT COUNT(*) FROM item").fetchone()[0])\ndb.close()\n',
  });
  python.write(
    "package.json",
    JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }),
  );
  const executed = Bun.spawnSync(["python3", join(python.root, "src/main.py")], { timeout: 5000 });
  expect(executed.exitCode).toBe(0);
  expect(executed.stdout.toString().trim()).toBe("1");
  const result = python.run("store", python.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"python":"3.12.12"');
  expect(result.output).toContain('"productionWrites":[{');
}, 180_000);

test("Python syntax, dynamic SQL and missing runtime are analysis errors", () => {
  for (const source of [
    "def broken(:\n pass\n",
    'import sqlite3,os\ndb=sqlite3.connect(":memory:")\ndb.execute(os.environ["SQL"])\n',
  ]) {
    using fixture = new Fixture({
      "src/main.ts": 'console.log("project");',
      "src/main.py": source,
    });
    fixture.write(
      "package.json",
      JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }),
    );
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(2);
    expect(result.output).toContain('"complete":false');
  }
  using fixture = new Fixture({
    "src/main.ts": 'console.log("project");',
    "src/main.py": "print(1)\n",
  });
  fixture.write(
    "package.json",
    JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }),
  );
  expect(
    fixture.run("store", [...fixture.schema(), "--python", join(fixture.root, "missing-python")])
      .code,
  ).toBe(2);
}, 180_000);

test("dynamic SQL and fresh/upgraded schema drift fail closed", () => {
  using dynamic = new Fixture({
    "src/adapter.ts": adapter.replace(
      '"SELECT * FROM item"',
      `\`SELECT * FROM \${process.env.TABLE}\``,
    ),
    "src/main.ts": 'import { read } from "./adapter"; read();',
  });
  expect(dynamic.run("store", dynamic.schema()).code).toBe(2);
  using drift = new Fixture({ "src/main.ts": 'console.log("root");' });
  const args = drift.schema();
  {
    using db = new Database(join(drift.root, "upgraded.db"));
    db.exec("CREATE TABLE extra (id INTEGER)");
  }
  args[7] = hash(readFileSync(join(drift.root, "upgraded.db")));
  const result = drift.run("store", args);
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"schema_drift"');
}, 180_000);
test("CLI distinguishes missing input, tampering, incomplete inventory and syntax", () => {
  expect(Bun.spawnSync([process.execPath, cli], { timeout: 5000 }).exitCode).toBe(2);
  using fixture = new Fixture({
    "src/main.ts": 'import { value } from "./api"; console.log(value);',
    "src/api.ts": "export const value = 1;",
  });
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
  for (const invoke of [
    "sink.publish(Ready, {});",
    "const emit = sink.publish; emit(Ready, {});",
    "const emit = sink.publish.bind(sink); emit(Ready, {});",
    "const { publish: emit } = sink; emit(Ready, {});",
  ]) {
    using fixture = new Fixture({
      "src/events.ts": protocol
        .replace('BusEvent.define("ready", {})', '{ name: "ready", schema: {} }')
        .replace("const Ready =", "const Ready: BusEvent.Descriptor ="),
      "src/main.ts": `import { Ready } from "./events"; const sink = { publish(event: { name: string }, data: object) { console.log(event.name, data); } }; ${invoke}`,
    });
    const result = fixture.run("publisher");
    expect(result.code).toBe(0);
    expect(result.output).toContain('"importOrAliasPath":[{');
  }
}, 180_000);
test("undeclared publisher fails and dynamic computed dispatch is incomplete", () => {
  using undeclared = new Fixture({
    "src/main.ts":
      'const sink = { publish(event: {name:string}, data: object){ console.log(event, data); } }; sink.publish({name:"missing",schema:{}}, {});',
  });
  const missing = undeclared.run("publisher");
  expect(missing.code).toBe(1);
  expect(missing.output).toContain('"publisher":1');
  using dynamic = new Fixture({
    "src/main.ts":
      'const sink = { publish(event: object){console.log(event);} }; sink[process.env.METHOD ?? "publish"]({});',
  });
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
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";
      const received:string[]=[];
      interface Sink { publish(event:{name:string},data:object):void }
      function use(sink:Sink){sink.publish(Ready,{})}
      function run(callback:()=>void){${invokes ? "callback();" : "return;"}}
      const sink:Sink={publish(event,data){received.push(event.name)}};
      run(()=>use(sink)); console.log(JSON.stringify(received));`,
    });
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
      timeout: 5000,
    });
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invokes ? '["ready"]' : "[]");
    expect(fixture.run("publisher").code).toBe(invokes ? 0 : 1);
  }
}, 180_000);

test("real Bun socket callback is an invoked publisher, not registration", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": `import {Ready} from "./events";
    const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};
    let delivered!:()=>void; const signal=new Promise<void>(resolve=>{delivered=resolve});
    const listener=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(socket,data){sink.publish(Ready,{});socket.end();delivered()}}});
    const client=await Bun.connect({hostname:"127.0.0.1",port:listener.port,socket:{open(socket){socket.write("trigger")},data(){}}});
    await signal;client.end();listener.stop(true);console.log(JSON.stringify(received));`,
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 10_000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("real AI SDK stream dispatch invokes the concrete tool callback", () => {
  expect(aiPackage.version).toBe("6.0.141");
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": `
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
  `,
  });
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(fixture.root, "node_modules"));
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 15_000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"ai":{"version":"6.0.141"');
}, 180_000);

test("shared forwarders do not credit a no-op argument from another invocation", () => {
  using fixture = new Fixture({
    "src/events.ts": `${protocol}\nexport const Other=BusEvent.define("other",{});`,
    "src/main.ts":
      'import {Ready,Other} from "./events";interface Sink{publish(event:{name:string},data:object):void} function send(sink:Sink,event:{name:string}){sink.publish(event,{})}const received:string[]=[];const noop:Sink={publish(){return}};const live:Sink={publish(event,data){received.push(event.name)}};send(noop,Ready);send(live,Other);console.log(JSON.stringify(received));',
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.stdout.toString().trim()).toBe('["other"]');
  const result = fixture.run("publisher");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"publisher":1');
}, 180_000);

test("collectors and unreachable effects do not grant publisher credit", () => {
  for (const body of [
    "return; received.push(event.name);",
    "if(false){received.push(event.name)}",
  ]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){${body}}};sink.publish(Ready,{});console.log(JSON.stringify(received));`,
    });
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
      timeout: 5000,
    });
    expect(actual.stdout.toString().trim()).toBe("[]");
    expect(fixture.run("publisher").code).toBe(1);
  }
  using collector = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts":
      'import {Ready} from "./events";const events:string[]=[];const sink={events,publish(event:{name:string},data:object){events.push(event.name)}};sink.publish(Ready,{});',
  });
  expect(collector.run("publisher").code).toBe(1);
}, 180_000);

test("Electron Vite roots include main, preload and HTML module entries", () => {
  using fixture = new Fixture({
    "src/electron.vite.config.ts":
      'export default {main:{build:{lib:{entry:"main.ts"}}},preload:{build:{lib:{entry:"preload.ts"}}},renderer:{build:{rollupOptions:{input:"index.html"}}}};',
    "src/main.ts": 'console.log("main");',
    "src/preload.ts": 'console.log("preload");',
    "src/renderer.ts": 'console.log("renderer");',
  });
  configureElectronFixture(fixture, '<SCRIPT TYPE=module SRC="./renderer.ts"></SCRIPT>');
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  for (const entry of ["main", "preload", "renderer"]) {
    expect(result.output).toContain(`"path":"src/${entry}.ts","invocation":`);
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, `src/${entry}.ts`)], {
      timeout: 5000,
    });
    expect(actual.stdout.toString().trim()).toBe(entry);
  }
  expect(result.output).toContain('"path":"src/index.html","sha256":');
}, 180_000);

test("scheduled and declaration-only registration callbacks reach their bodies", () => {
  for (const source of [
    "requestAnimationFrame(() => console.log('frame')); requestIdleCallback(() => console.log('idle'));",
    "import {store} from 'registration'; store.subscribe(() => console.log('subscription'));",
    "import './bridge'; const bridge = window.desktop; bridge?.onMessage(() => console.log('bridge'));",
  ]) {
    using fixture = new Fixture({
      "src/main.ts": source,
      "src/bridge.ts": "export {}; declare global { interface Window { desktop: { onMessage: (listener: () => void) => () => void } } }",
    });
    fixture.write("node_modules/registration/package.json", '{"name":"registration","types":"index.d.ts"}');
    fixture.write("node_modules/registration/index.d.ts", "export declare const store: {subscribe(listener: () => void): () => void};");
    const result = fixture.run("publisher");
    expect(result.output).toContain('"complete":true');
    expect(result.output).not.toContain('"unresolved_callback_edge"');
  }
}, 180_000);

test("rendered components, hook callbacks and DOM listeners consume renderer exports", () => {
  for (const rendered of [false, true]) {
    using fixture = new Fixture({
      "src/electron.vite.config.ts":
        'export default {main:{build:{lib:{entry:"main.ts"}}},renderer:{build:{rollupOptions:{input:"index.html"}}}};',
      "src/main.ts": 'console.log("main");',
      "src/state.ts":
        'import {Store} from "@tanstack/store";export type Facts={count:number};export const LIMIT=3;export const store=new Store<Facts>({count:0});export function bump(previous:number):number{return previous+1}export function selectCount(facts:Facts):number{return facts.count}export function onKey(event:KeyboardEvent):void{console.log(event.key)}export function reset(facts:Facts):Facts{return {...facts,count:0}}',
      "src/app.tsx":
        'import {useEffect,useState} from "react";import {useStore} from "@tanstack/react-store";import {bump,LIMIT,onKey,reset,selectCount,store} from "./state";import type {Facts} from "./state";export function App(){const [count,setCount]=useState(0);const stored=useStore(store,(facts:Facts)=>selectCount(facts));useEffect(()=>{document.addEventListener("keydown",onKey);return ()=>document.removeEventListener("keydown",onKey)},[]);return <button type="button" onClick={()=>setCount((previous)=>Math.min(LIMIT,bump(previous)))} onDoubleClick={()=>store.setState((previous)=>reset(previous))}>{count+stored}</button>}',
      "src/renderer.tsx": rendered
        ? 'import {createRoot} from "react-dom/client";import {App} from "./app";createRoot(document.body).render(<App/>);'
        : 'import {createRoot} from "react-dom/client";import "./app";createRoot(document.body).render(<p>idle</p>);',
    });
    configureElectronFixture(fixture, '<script type="module" src="./renderer.tsx"></script>');
    fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "preserve",
          moduleResolution: "bundler",
          target: "esnext",
          jsx: "react-jsx",
          lib: ["esnext", "dom"],
        },
        include: ["src"],
      }),
    );
    fixture.freeze();
    // React, TanStack and @types/react are installed for the desktop workspace only.
    symlinkSync(
      resolve(import.meta.dir, "../apps/desktop/node_modules"),
      join(fixture.root, "node_modules"),
    );
    const result = fixture.run("export");
    const report = JSON.parse(result.output) as {
      complete: boolean;
      errors: Problem[];
      findings: { path: string; symbol: string }[];
    };
    expect(report.complete).toBe(true);
    expect(report.errors).toEqual([]);
    const reported = report.findings
      .filter((finding) => finding.path === "src/state.ts")
      .map((finding) => finding.symbol)
      .sort();
    expect(reported).toEqual(
      rendered
        ? []
        : ["Facts", "LIMIT", "bump", "onKey", "reset", "selectCount", "store"],
    );
  }
}, 180_000);

test("JavaScript publishers and declaration-bound non-SQL query objects", () => {
  using javascript = new Fixture({
    "src/events.ts": protocol,
    "src/main.js":
      'import {Ready} from "./events.ts";const sink={publish(event,data){console.log(event.name)}};sink.publish(Ready,{})',
  });
  javascript.write(
    "package.json",
    JSON.stringify({ name: "fixture", scripts: { start: "bun src/main.js" } }),
  );
  expect(javascript.run("publisher").code).toBe(0);
  using impostor = new Fixture({
    "src/main.ts":
      'const db={query(sql:string){return {run(){return}}}};db.query("INSERT INTO item VALUES(1)").run();',
  });
  expect(impostor.run("store", impostor.schema()).code).toBe(1);
}, 180_000);

test("unbound ports fail closed while native scheduled callbacks are traced", () => {
  using port = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts":
      'import { Ready } from "./events"; declare const sink: {publish(event: object, data: object):void}; sink.publish(Ready, {});',
  });
  const unbound = port.run("publisher");
  expect(unbound.code).toBe(2);
  expect(unbound.output).toContain('"code":"unbound_publisher_port"');
  using callback = new Fixture({
    "src/main.ts": 'queueMicrotask(() => { console.log("callback"); });',
  });
  expect(callback.run("publisher").code).toBe(0);
}, 180_000);
test("Knip use without terminal provenance cannot silently pass registration", () => {
  using fixture = new Fixture({
    "src/api.ts": "export function read(){ return 1; }",
    "src/main.ts":
      'import { read } from "./api"; const registry = { read }; console.log(registry);',
  });
  const result = fixture.run("export");
  expect(result.code).toBe(1);
  expect(result.output).toContain('"symbol":"read","class":"export"');
}, 180_000);

test("platform AbortSignals resolve without publisher credit while unknown sources stay unresolved", () => {
  for (const source of [
    "AbortSignal.any([])",
    "AbortSignal.abort()",
    "new EventTarget()",
    "new AbortSignal()",
  ]) {
    const known = source !== "new AbortSignal()";
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";${source === "new AbortSignal()" ? "class AbortSignal extends EventTarget {}" : ""}const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};const signal=${source};signal.addEventListener("abort",()=>sink.publish(Ready,{}));console.log(JSON.stringify(received));`,
    });
    const native = Bun.spawnSync([process.execPath, "src/main.ts"], {
      cwd: fixture.root,
      timeout: 5000,
    });
    expect(native.exitCode).toBe(0);
    expect(native.stdout.toString().trim()).toBe("[]");
    const result = fixture.run("publisher");
    const document = jsonObject(decodeJson(result.output));
    expect(result.code).toBe(known ? 1 : 2);
    expect(jsonBoolean(document.complete)).toBe(known);
    expect(jsonArray(document.errors, (error) => jsonString(jsonObject(error).code))).toEqual(
      known ? [] : ["unresolved_event_source"],
    );
    expect(jsonNumber(jsonObject(document.counts).publisher)).toBe(1);
    expect(document.schemas).toMatchObject([{ name: "ready", productionPublishers: [] }]);
    expect(document.externalEvents).toEqual([]);
  }
}, 180_000);
