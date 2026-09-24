import { sessionTree } from "../../../packages/ledger/test/helpers/session-tree";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { bundle, bundlePolicyTag, BundlesLive, defineTool, eraseTool, sessionTool } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { Llm, run } from "@openomni/llm";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { residentSuite } from "./helpers/resident-suite";
import { auditBundle, ProviderRequest, providerResponse } from "./helpers/bundle-fixture";
import { nextMessage } from "./helpers/ws";
import { eventSignal } from "./helpers/event-signal";

const suite = residentSuite();
const echo = (name: string, execute: (text: string) => Promise<string>) => eraseTool(defineTool({
  name, category: "query", description: "Echo admitted input", input: z.object({ text: z.string() }), output: z.string(),
  visibility: { model: ["resident"], cell: ["resident"] }, execute: ({ text }) => execute(text), render: (_input, output) => output,
}));

for (const enabled of [false, true]) test(`one AppLive bundle argument controls real WS JSONL observation (${enabled})`, async () => {
  const directory = suite.tempDir("app-observer-");
  const path = join(directory, "audit.jsonl");
  const audit = auditBundle(path);
  let calls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    ProviderRequest.parse(await request.json());
    return providerResponse(++calls === 1 ? { name: "echo", input: { text: "observed" } } : undefined);
  } });
  suite.defer(() => provider.stop(true));
  const config = suite.config("app-observer-db-", { wsToken: "fixture", compactionSummarizer: false,
    model: { provider: "anthropic", id: "fixture", apiKey: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1` } });
  const runtime = gatewayRuntime({ dbPath: config.dbPath,
    bundles: enabled ? BundlesLive([audit.definition]) : BundlesLive([]),
    llm: Layer.succeed(Llm, { run, resolveModel: () => Effect.succeed({ providerID: "anthropic", id: "fixture", name: "fixture", api: { npm: "@ai-sdk/anthropic" } }) }),
  });
  const app = await suite.boot({ config, runtime, toolDefinitions: [echo("echo", async (text) => text)] });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "fixture"]);
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: "message", text: "echo" }));
  await reply;
  const row = SessionHandleStore.listRows().find((row) => row.id !== "gateway-ingress");
  if (row === undefined) throw new Error("missing resident");
  const hooks = sessionTree(row.id).filter((action) => action.kind === "policy.decision").map((action) => action.intent.value);
  expect(hooks).toEqual(expect.arrayContaining([expect.objectContaining({ hook: "tool.pre", op: "echo" }), expect.objectContaining({ hook: "tool.post", op: "echo" })]));
  const db = new Database(config.dbPath, { readonly: true });
  try { expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM action WHERE kind = 'policy.decision'").get()?.count).toBeGreaterThan(0); }
  finally { db.close(); }
  expect(existsSync(path)).toBe(enabled);
  if (enabled) {
    const entries = readFileSync(path, "utf8").trim().split("\n").map((line) => z.object({ event: z.string(), data: z.object({ sessionId: z.string() }) }).parse(JSON.parse(line)));
    expect(entries.map((entry) => entry.event)).toEqual(expect.arrayContaining(["tool.execution.started", "tool.execution.completed"]));
    expect(entries.every((entry) => entry.data.sessionId === row.id)).toBe(true);
  }
  await app.stop();
  expect(audit.closed.sort()).toEqual(audit.acquired.sort());
  expect(calls).toBe(2);
});

test("a held WS generation keeps its catalog and transformer while public tools.add selects the next generation", async () => {
  const path = join(suite.tempDir("held-observer-"), "audit.jsonl");
  const audit = auditBundle(path);
  const entered = eventSignal<void>("g1 body entered");
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  const base = echo("echo", async (text) => { seen.push(text); entered.resolve(); await release.promise; return text; });
  const demo = echo("demo__echo", async (text) => { seen.push(text); return text; });
  const Policy = bundlePolicyTag("demo");
  const policy = Layer.succeed(Policy, { transformers: [{ name: "demo/redact-home", apply: () => ({ text: "redacted" }) }], obligations: [] });
  const definition = bundle({ name: "demo", requires: [], provides: [Policy], layer: policy, tools: [demo], rows: [{
    name: "demo/redact", kind: "tool", phase: "pre", priority: 1000,
    match: { encodingVersion: 1, value: { op: "echo" } }, verdict: { encodingVersion: 1, value: { type: "transform", ref: "demo/redact-home" } },
  }] });
  const offered: string[][] = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = ProviderRequest.parse(await request.json());
    offered.push(body.tools?.map((tool) => tool.name) ?? []);
    const name = offered.length === 1 ? "echo" : offered.length === 3 ? "demo__echo" : undefined;
    return providerResponse(name === undefined ? undefined : { name, input: { text: "/home/private" } });
  } });
  suite.defer(() => provider.stop(true));
  const config = suite.config("app-bundle-swap-", { wsToken: "fixture", compactionSummarizer: false,
    model: { provider: "anthropic", id: "fixture", apiKey: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1` } });
  const runtime = gatewayRuntime({ dbPath: config.dbPath, bundles: BundlesLive([audit.definition, definition]),
    llm: Layer.succeed(Llm, { run, resolveModel: () => Effect.succeed({ providerID: "anthropic", id: "fixture", name: "fixture", api: { npm: "@ai-sdk/anthropic" } }) }),
  });
  const app = await suite.boot({ config, runtime, toolDefinitions: [base] });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "fixture"]);
  const first = nextMessage(ws);
  try {
    ws.send(JSON.stringify({ type: "message", text: "hold" }));
    await entered.promise;
    const row = SessionHandleStore.listRows().find((row) => row.id !== "gateway-ingress");
    if (row === undefined) throw new Error("missing resident");
    const handle = app.sessions.get(row.id);
    if (handle === undefined) throw new Error("missing live session");
    const retired = eventSignal<void>("g1 observer finalized");
    void audit.whenClosed(2).then(retired.resolve, retired.reject);
    expect(await runAppEffect(runtime, handle.tools.add([sessionTool(demo)]))).toMatchObject({ generation: 2 });
    expect(audit.closed).not.toContain(2);
    release.resolve();
    await first;
    await retired.promise;
    const second = nextMessage(ws);
    ws.send(JSON.stringify({ type: "message", text: "next" }));
    await second;
    expect(offered.slice(0, 2).every((names) => !names.includes(demo.name))).toBe(true);
    expect(offered.slice(2).every((names) => names.includes(demo.name))).toBe(true);
    expect(seen).toEqual(["redacted", "/home/private"]);
    expect(audit.acquired).toEqual([1, 2, 3]);
    const observed = readFileSync(path, "utf8").trim().split("\n").map((line) => z.object({ acquisition: z.number(), data: z.object({ toolName: z.string() }) }).parse(JSON.parse(line)));
    expect(observed.filter((entry) => entry.data.toolName === "echo").map((entry) => entry.acquisition)).toEqual([2, 2]);
    expect(observed.filter((entry) => entry.data.toolName === "demo__echo").map((entry) => entry.acquisition)).toEqual([3, 3]);
    const actions = sessionTree(row.id);
    expect(actions.map((action) => action.intent.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "echo", originalArgs: { text: "/home/private" }, value: { text: "redacted" } }),
      expect.objectContaining({ hook: "tool.pre", ref: "demo/redact-home", transforms: [{ ruleId: "demo/redact", ref: "demo/redact-home" }] }),
    ]));
  } finally { release.resolve(); await first; }
});
