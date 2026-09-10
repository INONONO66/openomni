import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Fixture, protocol, adapter, assertPublication } from "./census-fixture";

test("R3 local events require matching receiver and a subsequent trigger", () => {
  for (const trigger of [
    "",
    'other.emit("trigger");',
    'emitter.emit("other");',
    'emitter.emit("trigger");',
  ]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {EventEmitter} from "node:events";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};const emitter=new EventEmitter(),other=new EventEmitter();emitter.on("trigger",()=>sink.publish(Ready,{}));${trigger}console.log(JSON.stringify(received));`,
    });
    const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
      cwd: fixture.root,
      timeout: 5000,
    });
    const invoked = trigger === 'emitter.emit("trigger");';
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invoked ? '["ready"]' : "[]");
    expect(fixture.run("publisher").code).toBe(invoked ? 0 : 1);
  }
}, 180_000);

test("R3 scheduled publication reaches the effect through helper parameters", () => {
  for (const effectful of [false, true]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";const received:string[]=[];function deliver(value:{name:string}){${effectful ? "received.push(value.name)" : "void value.name"}}const sink={publish(event:{name:string},data:object){queueMicrotask(()=>deliver(event))}};sink.publish(Ready,{});await new Promise<void>(resolve=>queueMicrotask(resolve));console.log(JSON.stringify(received));`,
    });
    assertPublication(fixture, effectful);
  }
}, 180_000);

test("R3 Python thread start, inactive branches and cursors have separate effects", () => {
  for (const operation of ["thread", "started", "inactive", "cursor", "shadow"]) {
    const source = `import sqlite3,threading\ndb=sqlite3.connect("state.db",check_same_thread=False)\ndb.execute("CREATE TABLE item(id INTEGER)")\n${
      {
        thread:
          'def save():\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\nthread=threading.Thread(target=save)\n',
        started:
          'def save():\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\nthread=threading.Thread(target=save)\nthread.start();thread.join()\n',
        inactive: 'if False:\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\n',
        cursor: 'cursor=db.cursor()\ncursor.execute("INSERT INTO item VALUES(1)")\ndb.commit()\n',
        shadow:
          'def save():\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\ndef run():\n def save():\n  return\n save()\nrun()\n',
      }[operation] ?? ""
    }db.close()\n`;
    using fixture = new Fixture({ "src/main.ts": 'console.log("project")', "src/main.py": source });
    fixture.write(
      "package.json",
      JSON.stringify({ name: "fixture", scripts: { start: "python3 src/main.py" } }),
    );
    const actual = Bun.spawnSync(
      [
        "python3",
        "-I",
        "-c",
        'import runpy,sqlite3;runpy.run_path("src/main.py");db=sqlite3.connect("state.db");print(db.execute("SELECT COUNT(*) FROM item").fetchone()[0]);db.close()',
      ],
      { cwd: fixture.root, timeout: 5000 },
    );
    const invoked = operation === "started" || operation === "cursor";
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invoked ? "1" : "0");
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(invoked ? 0 : 1);
    expect(result.output).toContain('"productionReads":[]');
  }
}, 180_000);

test("import.meta.main branch evaluated before its file becomes a spawned root still counts", () => {
  using fixture = new Fixture({
    "src/adapter.ts": adapter,
    "src/entry.ts":
      'import { write } from "./adapter"; export const ENTRY = "entry"; if (import.meta.main) { console.log(write()); }',
    "src/main.ts":
      'import {spawnSync} from "node:child_process"; import { ENTRY } from "./entry"; console.log(ENTRY); const child=spawnSync(process.execPath,["src/entry.ts"],{stdio:"inherit"}); if(child.status!==0)throw new Error("child failed");',
  });
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"productionWrites":[{');
}, 180_000);

test("R3 child Python source is rooted in its actual spawn invocation", () => {
  using fixture = new Fixture({
    "src/main.ts":
      'import {spawnSync} from "node:child_process";const child=spawnSync("python3",["src/worker.py"],{stdio:"inherit"});if(child.status!==0)throw new Error("child failed");',
    "src/worker.py":
      'import sqlite3\ndb=sqlite3.connect("state.db")\ndb.execute("CREATE TABLE item(id INTEGER)")\ndb.cursor().execute("INSERT INTO item VALUES(1)")\ndb.commit()\ndb.close()\n',
  });
  const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
    cwd: fixture.root,
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  {
    using db = new Database(join(fixture.root, "state.db"), { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item").get()?.n).toBe(1);
  }
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(0);
  expect(result.output).toContain('"rootInvocation":{"path":"package.json"');
  expect(result.output).toContain('"forwardingCallPath":[{"path":"src/main.ts"');
}, 180_000);

test("R3 unresolved process source and cursor identity are errors, not clean", () => {
  using processFixture = new Fixture({
    "src/main.ts":
      'import {spawnSync} from "node:child_process";spawnSync("python3",[process.env.WORKER ?? "src/worker.py"]);',
    "src/worker.py": "print(1)\n",
  });
  expect(processFixture.run("store", processFixture.schema()).code).toBe(2);
  using pythonFixture = new Fixture({
    "src/main.ts": 'console.log("project")',
    "src/main.py":
      'def save(cursor):\n cursor.execute("INSERT INTO item VALUES(1)")\nsave(globals()["cursor"])\n',
  });
  pythonFixture.write(
    "package.json",
    JSON.stringify({ scripts: { start: "python3 src/main.py" } }),
  );
  const result = pythonFixture.run("store", pythonFixture.schema());
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"unresolved_python_sql_receiver"');
}, 180_000);

test("R3 real observation bus transfers through its scheduled delivery", () => {
  using fixture = new Fixture({
    "src/protocol.ts": readFileSync(
      resolve(import.meta.dir, "../packages/protocol/src/bus/index.ts"),
      "utf8",
    ),
    "src/bus.ts": readFileSync(
      resolve(import.meta.dir, "../packages/agent/src/observation/bus.ts"),
      "utf8",
    ).replace('"@openomni/protocol"', '"./protocol"'),
    "src/events.ts":
      'import {BusEvent} from "./protocol";import {z} from "zod";export const Ready=BusEvent.define("ready",z.object({}));',
    "src/main.ts":
      'import {Bus} from "./bus";import {Ready} from "./events";const received:string[]=[];const signal=new Promise<void>(resolve=>{Bus.observe((event)=>{received.push(event.name);resolve()})});Bus.publish(Ready,{});await signal;Bus.reset();console.log(JSON.stringify(received));',
  });
  symlinkSync(resolve(import.meta.dir, "../node_modules"), join(fixture.root, "node_modules"));
  const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
    cwd: fixture.root,
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("optional-chained AbortSignal parameters resolve without inventing an abort", () => {
  for (const receiver of ["signal?", "signal!", "signal"]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";const sink={publish(event:{name:string},data:object){console.log(event.name)}};function attach(signal${receiver === "signal" ? "" : "?"}:AbortSignal){${receiver}.addEventListener("abort",()=>sink.publish(Ready,{}),{once:true})}attach();`,
    });
    const result = fixture.run("publisher");
    expect(result.output).toContain('"complete":true');
    expect(result.code).toBe(1);
  }
}, 180_000);

test("R3 removed listeners and untriggered abort controllers stay dormant", () => {
  for (const operation of ["removed", "abort-dormant", "abort-triggered"]) {
    const trigger =
      operation === "removed"
        ? 'const emitter=new EventEmitter();const callback=()=>sink.publish(Ready,{});emitter.on("trigger",callback);emitter.off("trigger",callback);emitter.emit("trigger");'
        : `const controller=new AbortController();controller.signal.addEventListener("abort",()=>sink.publish(Ready,{}));${operation === "abort-triggered" ? "controller.abort();" : ""}`;
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {EventEmitter} from "node:events";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};${trigger}console.log(JSON.stringify(received));`,
    });
    const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
      cwd: fixture.root,
      timeout: 5000,
    });
    const invoked = operation === "abort-triggered";
    expect(actual.exitCode).toBe(0);
    expect(actual.stdout.toString().trim()).toBe(invoked ? '["ready"]' : "[]");
    expect(fixture.run("publisher").code).toBe(invoked ? 0 : 1);
  }
}, 180_000);

test("R3 an unthrown catch around a scheduled noop is not publication", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts":
      'import {Ready} from "./events";const received:string[]=[];function deliver(operation:()=>void,eventName:string){try{operation()}catch{console.warn(eventName)}}const sink={publish(event:{name:string},data:object){queueMicrotask(()=>deliver(()=>{void event.name},event.name))}};sink.publish(Ready,{});await new Promise<void>(resolve=>queueMicrotask(resolve));console.log(JSON.stringify(received));',
  });
  const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
    cwd: fixture.root,
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe("[]");
  expect(actual.stderr.toString()).toBe("");
  expect(fixture.run("publisher").code).toBe(1);
}, 180_000);

test("R3 process signal callbacks are rooted in an operating-system trigger", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts":
      'import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};const signal=new Promise<void>(resolve=>process.once("SIGUSR2",()=>{sink.publish(Ready,{});resolve()}));process.kill(process.pid,"SIGUSR2");await signal;console.log(JSON.stringify(received));',
  });
  const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
    cwd: fixture.root,
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe('["ready"]');
  const result = fixture.run("publisher");
  expect(result.code).toBe(0);
  expect(result.output).toContain('"events":["SIGUSR2"]');
}, 180_000);

test("R3 Bun process entry invokes the child publisher rather than only importing it", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/worker.ts":
      'import {Ready} from "./events";const sink={publish(event:{name:string},data:object){console.log(event.name)}};if(import.meta.main)sink.publish(Ready,{});',
    "src/main.ts":
      'const child=Bun.spawnSync([process.execPath,"src/worker.ts"],{stdout:"inherit",stderr:"inherit"});if(child.exitCode!==0)throw new Error("child failed");',
  });
  const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
    cwd: fixture.root,
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe("ready");
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("R4 private process names and helper order require actual dispatch", () => {
  for (const live of [false, true])
    for (const native of [false, true]) {
      const body = native
        ? `process.on("private-trigger",()=>sink.publish(Ready,{}));${live ? 'process.emit("private-trigger");' : ""}`
        : `const emitter=new EventEmitter();function attach(){emitter.on("trigger",()=>sink.publish(Ready,{}))}function register(){attach()}function fire(){emitter.emit("trigger")}${live ? "register();fire();" : "fire();register();"}`;
      using fixture = new Fixture({
        "src/events.ts": protocol,
        "src/main.ts": `import {EventEmitter} from "node:events";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string},data:object){received.push(event.name)}};${body}console.log(JSON.stringify(received));`,
      });
      const actual = Bun.spawnSync([process.execPath, "src/main.ts"], {
        cwd: fixture.root,
        timeout: 5000,
      });
      expect(actual.exitCode).toBe(0);
      expect(actual.stdout.toString().trim()).toBe(live ? '["ready"]' : "[]");
      const result = fixture.run("publisher");
      expect(result.code).toBe(live ? 0 : 1);
      expect(result.output).toContain('"externalEvents":[]');
    }
}, 180_000);

test("R4 suspended Python construction and partial next do not execute later segments", () => {
  const bodies = [
    ["async def save():", "value.close()", false],
    ["async def save():", "asyncio.run(value)", true],
    ["def save():\n yield None", "value.close()", false],
    ["def save():\n yield None", "list(value)", true],
    ["def save():\n yield None", "next(value);value.close()", false],
    ["def save():\n if False:\n  yield None", "value.close()", false],
    ["def save():\n if False:\n  yield None", "list(value)", true],
  ] as const;
  for (const [definition, driver, live] of bodies) {
    using fixture = new Fixture({
      "src/main.ts": 'console.log("project")',
      "src/main.py": `import sqlite3,asyncio\ndb=sqlite3.connect("state.db")\ndb.execute("CREATE TABLE item(id INTEGER)")\n${definition}\n db.execute("INSERT INTO item VALUES(1)")\n db.commit()\nvalue=save()\n${driver}\ndb.close()\n`,
    });
    fixture.write("package.json", JSON.stringify({ scripts: { start: "python3 src/main.py" } }));
    const actual = Bun.spawnSync(["python3", "src/main.py"], { cwd: fixture.root, timeout: 5000 });
    expect(actual.exitCode).toBe(0);
    {
      using db = new Database(join(fixture.root, "state.db"), { readonly: true });
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item").get()?.n).toBe(
        live ? 1 : 0,
      );
    }
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(live ? 0 : 1);
    expect(result.output).toContain('"productionReads":[]');
  }
}, 180_000);

test("R4 dynamic native triggers and unmodeled consumers stay incomplete", () => {
  using event = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts":
      'import {Ready} from "./events";const sink={publish(e:{name:string},data:object){console.log(e.name)}};process.on(process.env.EVENT ?? "private",()=>sink.publish(Ready,{}));',
  });
  expect(event.run("publisher").code).toBe(2);
  using python = new Fixture({
    "src/main.ts": 'console.log("project")',
    "src/main.py":
      'import sqlite3\ndb=sqlite3.connect("state.db")\ndef save():\n yield None\n db.execute("INSERT INTO item VALUES(1)")\nvalue=save()\nconsumer=globals()["consume"]\nconsumer(value)\n',
  });
  python.write("package.json", JSON.stringify({ scripts: { start: "python3 src/main.py" } }));
  const result = python.run("store", python.schema());
  expect(result.code).toBe(2);
  expect(result.output).toContain('"code":"unresolved_python_suspended_consumer"');
}, 180_000);

test("native exit listeners removed before termination do not publish", () => {
  for (const removed of [true, false]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";const received:string[]=[];const sink={publish(e:{name:string},data:object){received.push(e.name)}};const callback=()=>sink.publish(Ready,{});process.on("exit",callback);${removed ? 'process.off("exit",callback);' : ""}process.on("exit",()=>console.log(JSON.stringify(received)));`,
    });
    const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
      timeout: 5000,
    });
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
    fixture.write(
      "package.json",
      JSON.stringify({ name: "fixture", private: true, scripts: { start: "python3 src/main.py" } }),
    );
    const actual = Bun.spawnSync(["python3", "src/main.py"], { cwd: fixture.root, timeout: 5000 });
    expect(actual.exitCode).toBe(0);
    expect(actual.stderr.toString()).toBe("");
    using db = new Database(join(fixture.root, "state.db"), { readonly: true });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item").get()?.n).toBe(
      same ? 1 : 0,
    );
    const result = fixture.run("store", fixture.schema());
    expect(result.code).toBe(same ? 0 : 1);
    expect(result.output).toContain('"complete":true');
  }
}, 180_000);

test("native composed abort signals retain controller provenance without inventing an abort", () => {
  for (const fired of [false, true]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {Ready} from "./events";const received:string[]=[];const controller=new AbortController();const signal=AbortSignal.any([controller.signal]);const sink={publish(e:{name:string},data:object){received.push(e.name)}};signal.addEventListener("abort",()=>sink.publish(Ready,{}));${fired ? "controller.abort();" : ""}console.log(JSON.stringify(received));`,
    });
    const native = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
      timeout: 5000,
    });
    expect(native.exitCode).toBe(0);
    expect(native.stdout.toString().trim()).toBe(fired ? '["ready"]' : "[]");
    const result = fixture.run("publisher");
    expect(result.code).toBe(fired ? 0 : 1);
    expect(result.output).toContain('"complete":true');
  }
}, 180_000);

test("extensionless dynamic source imports are resolved, not classified as dynamic code", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": 'const {publish}=await import("./publisher");publish();',
    "src/publisher.ts":
      'import {Ready} from "./events";export function publish(){const sink={publish(e:{name:string},data:object){console.log(e.name)}};sink.publish(Ready,{})}',
  });
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("native module interposition invokes the factory for an already imported module", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": `import * as modules from "node:module";import * as events from "node:events";import {Ready} from "./events";const moduleLoader:{createRequire(path:string):(id:string)=>{mock:{module(id:string,factory:()=>object):void}}}=modules;const {mock}=moduleLoader.createRequire(import.meta.url)("bun:test");const received:string[]=[];const sink={publish(e:{name:string},data:object){received.push(e.name)}};mock.module("node:events",()=>{sink.publish(Ready,{});return events});console.log(JSON.stringify(received));`,
  });
  const native = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(native.exitCode).toBe(0);
  expect(native.stdout.toString().trim()).toBe('["ready"]');
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("AsyncResource invokes callbacks in its native synchronous scope", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": `import {AsyncResource} from "node:async_hooks";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string}){received.push(event.name)}};const resource=new AsyncResource("census");resource.runInAsyncScope(()=>sink.publish(Ready));resource.emitDestroy();console.log(JSON.stringify(received));`,
  });
  assertPublication(fixture, true);
}, 180_000);

test("AsyncResource.bind hands back the callback bound to its native async scope", () => {
  for (const invoked of [false, true]) {
    using fixture = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {AsyncResource} from "node:async_hooks";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string}){received.push(event.name)}};function tick(){sink.publish(Ready)}const evaluate=AsyncResource.bind(tick);${invoked ? "evaluate();" : ""}console.log(JSON.stringify(received));`,
    });
    assertPublication(fixture, invoked);
  }
}, 180_000);

test("fs.watch listeners and watcher events have a native filesystem producer", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    // Watch an existing file: macOS directory watches can miss creation before
    // their native stream starts. File watches register before watch() returns.
    "src/main.ts": `import {watch,writeFileSync,mkdtempSync,rmSync} from "node:fs";import {join} from "node:path";import {tmpdir} from "node:os";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string}){received.push(event.name)}};const dir=mkdtempSync(join(tmpdir(),"census-watch-"));const marker=join(dir,"marker");writeFileSync(marker,"0");const seen=new Promise<void>((resolve,reject)=>{const source=watch(marker,{recursive:false},()=>{sink.publish(Ready);source.close();resolve()});source.on("error",(error)=>{source.close();reject(error)})});try{writeFileSync(marker,"1");await seen;console.log(JSON.stringify(received))}finally{rmSync(dir,{recursive:true,force:true})}`, 
  });
  assertPublication(fixture, true);
  // The watcher's own error event is a native producer; an empty handler is not.
  for (const handled of [false, true]) {
    using watcher = new Fixture({
      "src/events.ts": protocol,
      "src/main.ts": `import {watch} from "node:fs";import {Ready} from "./events";const sink={publish(event:{name:string}){console.log(event.name)}};const source=watch(".",()=>{});source.on("error",()=>{${handled ? "sink.publish(Ready);" : ""}});source.close();`,
    });
    expect(watcher.run("publisher").code).toBe(handled ? 0 : 1);
  }
}, 180_000);

/** A fixture whose `electron` dependency carries the real `electron.d.ts` types over a
 * runtime double (`index` is evaluated with the fixture root bound as `root`). Returns the
 * fixture plus the trimmed stdout of running `src/main.ts`, which must exit 0. */
function electronFixture(
  files: Record<string, string>,
  index: (root: string) => string,
): { fixture: Fixture; stdout: string } {
  const electron = dirname(
    Bun.resolveSync("electron/package.json", resolve(import.meta.dir, "../apps/desktop")),
  );
  const fixture = new Fixture(files);
  fixture.write(
    "node_modules/electron/package.json",
    JSON.stringify({ name: "electron", type: "module", main: "index.js", types: "electron.d.ts" }),
  );
  fixture.write(
    "node_modules/electron/electron.d.ts",
    readFileSync(join(electron, "electron.d.ts"), "utf8"),
  );
  fixture.write("node_modules/electron/index.js", index(fixture.root));
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  return { fixture, stdout: actual.stdout.toString().trim() };
}

const ELECTRON_SINK = `import {BrowserWindow} from "electron";import {Ready} from "./events";const received:string[]=[];const sink={publish(event:{name:string}){received.push(event.name)}};`;
const ELECTRON_REPORT = "console.log(JSON.stringify(received));";

test.each([false, true])("Electron renderer listeners require a real window load edge: loaded=%s", (loaded) => {
    // The dependency double delivers the documented event only after loading.
    const run = electronFixture(
      {
        "src/events.ts": protocol,
        "src/main.ts": `${ELECTRON_SINK}function attach(window:BrowserWindow){const {webContents}=window;webContents.on("console-message",()=>sink.publish(Ready))}const window=new BrowserWindow();attach(window);${loaded ? 'await window.loadFile("index.html");' : ""}${ELECTRON_REPORT}`,
      },
      () =>
        'import {EventEmitter} from "node:events";export class BrowserWindow{webContents=new EventEmitter();loadFile(){this.webContents.emit("console-message",{});return Promise.resolve()}}',
    );
    using fixture = run.fixture;
    expect(run.stdout).toBe(loaded ? '["ready"]' : "[]");
    expect(fixture.run("publisher").code).toBe(loaded ? 0 : 2);
}, 180_000);

test.each([false, true])("Electron window listeners credit window-manager events; first paint needs the load edge: loaded=%s", (loaded) => {
    // The dependency double paints (ready-to-show) only after loading.
    const run = electronFixture(
      {
        "src/events.ts": protocol,
        "src/main.ts": `${ELECTRON_SINK}const window=new BrowserWindow();window.on("resize",()=>sink.publish(Ready));window.once("ready-to-show",()=>sink.publish(Ready));${loaded ? 'await window.loadFile("index.html");' : ""}${ELECTRON_REPORT}`,
      },
      () =>
        'import {EventEmitter} from "node:events";export class BrowserWindow extends EventEmitter{loadFile(){this.emit("ready-to-show");return Promise.resolve()}}',
    );
    using fixture = run.fixture;
    expect(run.stdout).toBe(loaded ? '["ready"]' : "[]");
    const result = fixture.run("publisher");
    expect(result.code).toBe(loaded ? 0 : 2);
    expect(result.output.includes("unsupported_native_event_lifecycle")).toBe(!loaded);
}, 180_000);

test.each([
  ["ready", "", "attach();", true, '["ready"]', 0],
  ["ready", "", "app.whenReady().then(attach);", true, "[]", 2],
  ["activate", "", "attach();", true, '["ready"]', 0],
  ["window-all-closed", "create();", "attach();", true, '["ready"]', 0],
  ["window-all-closed", "", "attach();", true, "[]", 2],
  ["ready", "", "attach();", false, '["ready"]', 2],
] as const)("Electron app lifecycle follows entry, readiness and window construction: %j", (event, create, attach, electronRoot, stdout, code) => {
    const run = electronFixture(
      {
        "src/events.ts": protocol,
        "src/electron.vite.config.ts": 'export default {main:{build:{lib:{entry:"main.ts"}}}};',
        "src/main.ts": `${ELECTRON_SINK}import {app} from "electron";
function create(){return new BrowserWindow()}
${create}
function attach(){app.on("${event}",()=>sink.publish(Ready))}
${attach}
await new Promise<void>(resolve=>queueMicrotask(resolve));${ELECTRON_REPORT}`,
      },
      () => 'import {EventEmitter} from "node:events";export const app=new EventEmitter();app.whenReady=()=>Promise.resolve();export class BrowserWindow{constructor(){queueMicrotask(()=>app.emit("window-all-closed"))}}queueMicrotask(()=>{app.emit("ready");app.emit("activate")});',
    );
    using fixture = run.fixture;
    if (electronRoot)
      fixture.write("src/package.json", JSON.stringify({ name: "desktop", scripts: { build: "electron-vite build" } }));
    expect(run.stdout).toBe(stdout);
    const result = fixture.run("publisher");
    expect(result.code).toBe(code);
    if (code === 0) expect(result.output).toContain(`"events":["${event}"]`);
    else expect(result.output).toContain("unsupported_native_event_lifecycle");
}, 180_000);

test("Electron app.getPath roots a durable file family like homedir does", () => {
  // The dependency double resolves the per-user directory to the fixture root.
  const run = electronFixture(
    {
      "src/main.ts": `import {app} from "electron";import {readFileSync,writeFileSync} from "node:fs";import {join} from "node:path";const file=()=>join(app.getPath("userData"),"window-bounds.json");writeFileSync(file(),"sentinel");console.log(readFileSync(file(),"utf8"));`,
    },
    (root) => `export const app={getPath(){return ${JSON.stringify(root)}}};`,
  );
  using fixture = run.fixture;
  expect(run.stdout).toBe("sentinel");
  const result = fixture.run("store", fixture.schema());
  expect(result.output).not.toContain("dynamic_store_boundary");
  expect(result.output).toContain('"family":"$electron.userData/window-bounds.json"');
  expect(result.output).toContain('"productionWrites":[{');
  expect(result.output).toContain('"productionReads":[{');
}, 180_000);

test("forwarded CLI argument slices retain their filesystem input family", () => {
  using fixture = new Fixture({
    "src/main.ts": `async function read(path:string){return Bun.file(path).text()}
function forward(args:readonly string[]){return read(args[0]!)}
function main(args=process.argv.slice(2)){return forward(args)}
console.log(await main());`,
  });
  fixture.write("state.json", "sentinel");
  const actual = Bun.spawnSync(
    [process.execPath, join(fixture.root, "src/main.ts"), join(fixture.root, "state.json")],
    { timeout: 5000 },
  );
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe("sentinel");
  const result = fixture.run("store", fixture.schema());
  expect(result.code).toBe(1); // The unrelated item table remains unconsumed.
  expect(result.output).toContain('"complete":true');
  expect(result.output).toContain('"family":"$argv.slice(2).0"');
}, 180_000);

test("an explicitly undefined callback argument invokes its default implementation", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": `import {Ready} from "./events";
const sink={publish(event:{name:string}){console.log(event.name)}};
const options={boundary(){return (body:()=>void)=>body()}};
function run(boundary=options.boundary()){boundary(()=>sink.publish(Ready))}
run(undefined);`,
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe("ready");
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);

test("child process stdout data listeners have a concrete spawned producer", () => {
  using fixture = new Fixture({
    "src/events.ts": protocol,
    "src/main.ts": `import {spawn} from "node:child_process";import {Ready} from "./events";const child=spawn(process.execPath,["-e","console.log(1)"]);const sink={publish(e:{name:string},data:object){console.log(e.name)}};child.stdout.on("data",()=>sink.publish(Ready,{}));await new Promise<void>((resolve,reject)=>{child.once("exit",()=>resolve());child.once("error",reject)});`,
  });
  const actual = Bun.spawnSync([process.execPath, join(fixture.root, "src/main.ts")], {
    timeout: 5000,
  });
  expect(actual.exitCode).toBe(0);
  expect(actual.stdout.toString().trim()).toBe("ready");
  expect(fixture.run("publisher").code).toBe(0);
}, 180_000);
