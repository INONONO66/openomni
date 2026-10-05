import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bundle, Core, Model } from "@openomni/agent";
import { L0Observation } from "@openomni/protocol";
type RunInput = Model.RunInput;
type Sink = Model.Sink;
import { Context, Effect, Layer } from "effect";
import {
  hooksJsonBundle,
  readHooksJson,
  SECRETS_GUARD_REF,
  secretsGuard,
} from "../src/bundles/hooks-json";
import { composedHolderOf } from "../src/composition/composed";
import { createWatchPlane } from "../src/composition/watch-plane";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { appManifest } from "../src/manifest";
import { gateRowPolicySeeds } from "../src/policy-seed";
import { AppInvariantError } from "../src/invariant";
import { assistantMessage } from "./helpers/assistant-message";
import { planeOf } from "./helpers/ledger";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { Bus } from "./helpers/bus";
import { z } from "zod";
import { executionReads } from "../../../packages/agent/test/helpers/execution-reads";
import { isolated, isolatedLedger } from "../../../packages/agent/test/helpers/isolated";
import { testExecutor, runAgentSync } from "../../../packages/agent/test/helpers/executor";
import { catalogLayer } from "../../../packages/agent/test/helpers/service-layers";
import { runEffect } from "./helpers/effect";
import { eventSignal } from "./helpers/event-signal";
import { testEntropy } from "./helpers/test-entropy";

/**
 * #1256 hooks-json: the product bundle compiling a hooks JSON file into gate
 * rows over the hook capability, wired through the REAL `appManifest ->
 * compose` boot (and `startOpenOmni` for the file path), fail-closed at every
 * refusal edge.
 */

const suite = residentSuite();

async function alarmDefinition(): Promise<Bundle.CapabilityDefinition<"alarm">> {
  const capability = await runEffect(
    Bundle.alarmCapability({
      bundles: [],
      compose: Core.composeAlarmPurposes,
      arm: () => () => Effect.die(new Error("unused arm")),
      watch: { install: () => Effect.void },
    }),
  );
  return capability.definition;
}

function composed(input?: {
  hooks?: Parameters<typeof hooksJsonBundle>[0];
  off?: readonly string[];
}) {
  return alarmDefinition().then((alarm) =>
    Bundle.composeSync(
      appManifest({
        alarm,
        wake: { close: () => undefined },
        ...(input?.hooks === undefined ? {} : { hooks: input.hooks }),
        ...(input?.off === undefined ? {} : { off: input.off }),
      }),
    ),
  );
}

test("the four mapped events compile to rows on their points over hook/process", async () => {
  const generation = await composed({
    hooks: {
      PreToolUse: [
        { command: ["./guard.sh"], timeoutMs: 1_000 },
        { guard: "secrets-guard", fields: ["command"] },
      ],
      PostToolUse: [{ command: ["./audit.sh"], timeoutMs: 2_000 }],
      UserPromptSubmit: [{ command: ["./prompt.sh"], timeoutMs: 3_000 }],
      SessionStart: [{ command: ["./start.sh"], timeoutMs: 4_000 }],
    },
  });
  const hooksRows = generation.rows.filter((row) => row.id.startsWith("hooks-json/"));
  expect(hooksRows).toEqual([
    {
      id: "hooks-json/tool.pre#1",
      on: "tool.pre",
      when: {},
      do: "gate",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "PreToolUse", command: ["./guard.sh"], timeoutMs: 1_000 },
      },
      order: 500,
    },
    {
      id: "hooks-json/tool.pre#2",
      on: "tool.pre",
      when: {},
      do: "rewrite",
      // #1256 r3 H-3: a rewrite row declares its fields, validated against
      // the point registry at compile.
      how: {
        ref: SECRETS_GUARD_REF,
        fields: ["command"],
        params: { event: "PreToolUse", fields: ["command"] },
      },
      order: 501,
    },
    {
      id: "hooks-json/tool.post#1",
      on: "tool.post",
      when: {},
      // PostToolUse is audit-only: it annotates, it cannot block (#1256).
      do: "observe",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "PostToolUse", command: ["./audit.sh"], timeoutMs: 2_000 },
      },
      order: 502,
    },
    {
      id: "hooks-json/prompt.pre#1",
      on: "prompt.pre",
      when: {},
      do: "gate",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "UserPromptSubmit", command: ["./prompt.sh"], timeoutMs: 3_000 },
      },
      order: 503,
    },
    {
      id: "hooks-json/session.open#1",
      on: "session.open",
      when: {},
      do: "gate",
      how: {
        ref: Bundle.HOOK_PROCESS_REF,
        params: { event: "SessionStart", command: ["./start.sh"], timeoutMs: 4_000 },
      },
      order: 504,
    },
  ]);
  // Both handler registrations are composed: the capability's process target
  // and the bundle's in-process example transformer.
  expect(generation.handlers.has(Bundle.HOOK_PROCESS_REF)).toBe(true);
  expect(generation.handlers.has(SECRETS_GUARD_REF)).toBe(true);
});

test("no hooks config composes the bundle with zero rows and the action input admitted", async () => {
  const generation = await composed();
  expect(generation.bundles).toEqual(["monitor", "cron", "hooks-json"]);
  expect(generation.rows.filter((row) => row.id.startsWith("hooks-json/"))).toEqual([]);
  expect(generation.inputs).toEqual(["action"]);
  expect(Object.keys(generation.kinds)).toEqual(["action"]);
});

/** Runs the refusing thunk and returns the TYPED refusal (#1256 r3 M-4). */
function refusalOf(run: () => unknown): AppInvariantError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppInvariantError);
    return error as AppInvariantError;
  }
  throw new Error("expected an AppInvariantError refusal");
}

test("readHooksJson refuses an unmapped event, non-JSON bytes and an unreadable path, each typed", () => {
  const dir = suite.tempDir("hooks-json-read-");
  const unmapped = join(dir, "unmapped.json");
  writeFileSync(unmapped, JSON.stringify({ Notification: [{ command: ["./x"] }] }));
  // M-4: the failure class and its machine-consumed code, plus the offending
  // datum (the event name) — never a prose-only match.
  const unmappedRefusal = refusalOf(() => readHooksJson(unmapped));
  expect(unmappedRefusal.code).toBe("unmapped_event");
  expect(unmappedRefusal.message).toContain("Notification");
  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, "not json");
  expect(refusalOf(() => readHooksJson(invalid)).code).toBe("not_json");
  expect(refusalOf(() => readHooksJson(join(dir, "absent.json"))).code).toBe("unreadable_path");
  const badShape = join(dir, "bad-shape.json");
  writeFileSync(badShape, JSON.stringify({ PreToolUse: [{ command: [] }] }));
  expect(refusalOf(() => readHooksJson(badShape)).code).toBe("invalid_config");
  // A guard entry on a tool event without declared fields, and any guard on
  // the no-rewrite SessionStart point, each refuse typed at bundle compile.
  expect(refusalOf(() => hooksJsonBundle({ PreToolUse: [{ guard: "secrets-guard" }] })).code).toBe(
    "missing_rewrite_fields",
  );
  expect(refusalOf(() => hooksJsonBundle({ SessionStart: [{ guard: "secrets-guard" }] })).code).toBe(
    "session_start_rewrite",
  );
  // The default call bound applies when the file omits timeoutMs.
  const defaults = join(dir, "defaults.json");
  writeFileSync(defaults, JSON.stringify({ PreToolUse: [{ command: ["./guard.sh"] }] }));
  expect(readHooksJson(defaults)).toEqual({
    PreToolUse: [{ command: ["./guard.sh"], timeoutMs: 5_000 }],
  });
});

test("secretsGuard masks secret-shaped tokens recursively and leaves clean values byte-identical", () => {
  const input = {
    command: "curl -H 'x-key: sk-abcdef123456789' https://api",
    nested: { aws: "AKIAABCDEFGHIJKLMNOP", note: "plain text stays" },
    list: ["ghp_0123456789abcdefghij", 42, null, true],
  };
  expect(secretsGuard(input, null)).toEqual({
    command: "curl -H 'x-key: [redacted]' https://api",
    nested: { aws: "[redacted]", note: "plain text stays" },
    list: ["[redacted]", 42, null, true],
  });
  expect(secretsGuard("no secrets here", null)).toBe("no secrets here");
});

test("off cascades: action roots hook and hooks-json off; hook roots hooks-json off", async () => {
  const offAction = await composed({ off: ["action"] });
  expect(offAction.disabled).toEqual([
    { name: "action", because: "action" },
    { name: "hook", because: "action" },
    { name: "hooks-json", because: "action" },
  ]);
  expect(offAction.inputs).toEqual([]);
  const offHook = await composed({ off: ["hook"] });
  expect(offHook.disabled).toEqual([
    { name: "hook", because: "hook" },
    { name: "hooks-json", because: "hook" },
  ]);
  expect(offHook.bundles).toEqual(["monitor", "cron"]);
});

test("without the hook capability the bundle refuses at compose as seam_missing", () => {
  expect(() =>
    Bundle.composeSync(
      Bundle.Manifest.define({ capabilities: [], bundles: [hooksJsonBundle()], off: [] }),
    ),
  ).toThrow(Bundle.ComposeRefused);
  try {
    Bundle.composeSync(
      Bundle.Manifest.define({ capabilities: [], bundles: [hooksJsonBundle()], off: [] }),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(Bundle.ComposeRefused);
    if (error instanceof Bundle.ComposeRefused) expect(error.code).toBe("seam_missing");
  }
});

test("a guard rewrite row seeds the live transform; a command gate row seeds the consult verdict (H-1)", async () => {
  const guarded = await composed({
    hooks: { PreToolUse: [{ guard: "secrets-guard", fields: ["command"] }] },
  });
  const seeds = gateRowPolicySeeds(guarded.rows.filter((row) => row.id.startsWith("hooks-json/")));
  expect(seeds).toEqual([
    {
      name: "hooks-json/tool.pre#1",
      kind: "tool",
      phase: "pre",
      priority: 500,
      match: { encodingVersion: 1, value: {} },
      verdict: {
        encodingVersion: 1,
        value: {
          type: "transform",
          ref: SECRETS_GUARD_REF,
          config: { event: "PreToolUse", fields: ["command"] },
        },
      },
    },
  ]);
  const command = await composed({
    hooks: { PreToolUse: [{ command: ["./guard.sh"], timeoutMs: 1_000 }] },
  });
  // #1256 r2 H-1: the command gate row seeds the consult verdict — the named
  // async service the compiled snapshot resolves through `hook/process`.
  expect(
    gateRowPolicySeeds(command.rows.filter((row) => row.id.startsWith("hooks-json/"))),
  ).toEqual([
    {
      name: "hooks-json/tool.pre#1",
      kind: "tool",
      phase: "pre",
      priority: 500,
      match: { encodingVersion: 1, value: {} },
      verdict: {
        encodingVersion: 1,
        value: {
          type: "consult",
          ref: Bundle.HOOK_PROCESS_REF,
          config: { event: "PreToolUse", command: ["./guard.sh"], timeoutMs: 1_000 },
        },
      },
    },
  ]);
});

test("startOpenOmni compiles the Owner's hooks file at boot and seeds its row into the catalog", async () => {
  const dir = suite.tempDir("hooks-json-boot-");
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({ PreToolUse: [{ guard: "secrets-guard", fields: ["command"] }] }),
  );
  const config = suite.config("hooks-json-boot-state-", { hooksPath });
  await suite.boot({ config, llm: { resolveModel: fakeProviderModel } });
  if (config.catalogPath === undefined) throw new Error("suite config always sets catalogPath");
  const database = new Database(config.catalogPath, { readonly: true });
  try {
    const names = database
      .query<{ name: string }, []>(
        "SELECT DISTINCT name FROM policy WHERE name LIKE 'hooks-json/%'",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual(["hooks-json/tool.pre#1"]);
  } finally {
    database.close();
  }
});

test("a hooks file with an unmapped event refuses the boot before any listener exists", async () => {
  const dir = suite.tempDir("hooks-json-refuse-");
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(hooksPath, JSON.stringify({ Stop: [{ command: ["./x"] }] }));
  const config = suite.config("hooks-json-refuse-state-", { hooksPath });
  // M-4: the TYPED refusal object crosses the boot boundary — class, code and
  // the offending event name, not a prose match.
  const refusal = await suite
    .boot({ config, llm: { resolveModel: fakeProviderModel } })
    .then(() => undefined, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(AppInvariantError);
  if (!(refusal instanceof AppInvariantError)) throw new Error("expected AppInvariantError");
  expect(refusal.code).toBe("unmapped_event");
  expect(refusal.message).toContain("Stop");
});

/**
 * One deterministic run through the REAL index.ts wiring: boot with every
 * bundle on (pinned clock, counting entropy), run one turn, then swap the
 * composed holder to the `off: ["hook"]` composition — exactly what
 * `provision{bundle_disable}`'s recompose commit does — and run the next
 * turn. Rotation is strictly between turns; the adoption journals the
 * cascade. Returns the turn session's full journal chain.
 */
async function offCascadeConfigureRows(prefix: string) {
  let counter = 0;
  const config = suite.config(prefix);
  const watch = createWatchPlane();
  const onManifest = appManifest({ alarm: watch.contract, wake: watch.wake });
  const offManifest = appManifest({ alarm: watch.contract, wake: watch.wake, off: ["hook"] });
  const holder = composedHolderOf({
    manifest: onManifest,
    generation: Bundle.composeSync(onManifest),
  });
  let calls = 0;
  const runtime = gatewayRuntime({
    observations: Bus,
    composed: holder,
    ...(config.catalogPath === undefined ? {} : { catalogPath: config.catalogPath }),
    ...(config.sessionsDir === undefined ? {} : { sessionsDir: config.sessionsDir }),
    now: () => 1_700_000_000_000,
    clusterClock: "injected",
    entropy: testEntropy(() => `e-${++counter}`),
    llm: Layer.unwrap(
      Effect.map(Layer.build(Model.LlmLive), (live) =>
        Layer.succeed(Model.Llm, {
          ...Context.get(live, Model.Llm),
          resolveModel: fakeProviderModel,
          run: (input: RunInput, sink: Sink) =>
            Effect.sync(() => {
              calls += 1;
              sink.onMessage(
                assistantMessage(input, {
                  id: `hook-reply-${calls}`,
                  text: `ready ${calls}`,
                  createdAt: 1_700_000_000_000,
                }),
              );
              return { type: "stop" as const };
            }),
        }),
      ),
    ),
  });
  const app = await suite.boot({ config, runtime });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  const reply1 = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: "hooks-on-turn", text: "warm" }));
  expect(await reply1).toMatchObject({ text: "ready 1" });
  // The recompose commit: the Owner's off-list now cascades hook off.
  holder.swap({ manifest: offManifest, generation: Bundle.composeSync(offManifest) });
  const reply2 = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: "hooks-off-turn", text: "go" }));
  expect(await reply2).toMatchObject({ text: "ready 2" });
  const sessions = plane
    .listSessions()
    .filter((row) => row.role === "resident" && row.id !== "gateway-ingress");
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0]?.id ?? "";
  // The adopted generation dropped the cascaded bundle.
  const adopted = plane.openKernel(sessionId).latestGenerationFor(sessionId);
  expect([...adopted.bundles].sort()).toEqual(["cron", "monitor"]);
  if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
  const database = new Database(join(config.sessionsDir, `${sessionId}.sqlite`), {
    readonly: true,
  });
  try {
    return database
      .query<
        {
          id: string;
          ts: number;
          parent_id: string | null;
          kind: string;
          intent: string;
          effect: string;
          ordinal: number;
          action_hash: string;
        },
        [string]
      >(
        "SELECT id, ts, parent_id, kind, intent, effect, ordinal, action_hash FROM action WHERE session_id = ? ORDER BY ordinal ASC",
      )
      .all(sessionId);
  } finally {
    database.close();
  }
}

test("capability-removed one-turn gate: the cascade is journaled in session.configure and the bytes are golden-stable", async () => {
  const first = await offCascadeConfigureRows("hooks-json-off-a-");
  await suite.cleanup();
  const second = await offCascadeConfigureRows("hooks-json-off-b-");
  // The compose adoption row records the cascade with its root `because`.
  const compose = first
    .map((row) => JSON.parse(row.intent) as { operation?: string; disabled?: unknown })
    .find((intent) => intent.operation === "compose");
  expect(compose?.disabled).toEqual([
    { name: "hook", because: "hook" },
    { name: "hooks-json", because: "hook" },
  ]);
  // Golden-stable: two runs from pinned clock/entropy journal identical bytes.
  expect(second).toEqual(first);
});

/** The scripted hook: denies any decision input containing the argv trigger (default "forbidden"). */
const PROMPT_HOOK_SCRIPT = `
const trigger = process.argv[2] ?? "forbidden";
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const result = JSON.stringify(request.decisionInput).includes(trigger)
      ? { type: "gate", verdict: "deny", reason: "hook_refused" }
      : { type: "gate", verdict: "allow" };
    console.log(JSON.stringify({ id: request.id, result }));
  }
}
`;

test("H-1/M-2 e2e: a UserPromptSubmit command hook gates the REAL prompt path and journals durable policy.decision rows", async () => {
  const dir = suite.tempDir("hooks-json-e2e-");
  const script = join(dir, "prompt-hook.js");
  writeFileSync(script, PROMPT_HOOK_SCRIPT);
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({
      UserPromptSubmit: [{ command: [process.execPath, script], timeoutMs: 30_000 }],
    }),
  );
  const config = suite.config("hooks-json-e2e-state-", { hooksPath });
  let calls = 0;
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          calls += 1;
          sink.onMessage(
            assistantMessage(input, { id: `hook-e2e-${calls}`, text: `ok ${calls}`, createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);

  // Subscribe to the exact committed fact BEFORE sending: the denied prompt's
  // durable policy.decision row (fail-closed consult verdict folded to deny).
  const denied = eventSignal<{ sessionId: string; id: string }>("denied policy.decision", 15_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "policy.decision") return;
    const node = plane.openKernel(event.sessionId).actionById(event.id);
    const intent = node?.intent.value;
    if (intent !== null && typeof intent === "object" && !Array.isArray(intent) && intent?.verdict === "deny")
      denied.resolve({ sessionId: event.sessionId, id: event.id });
  });
  try {
    ws.send(JSON.stringify({ type: "message", eventId: "hook-deny", text: "read the forbidden file" }));
    const denial = await denied.promise;

    // The denied prompt never reached the model; the next allowed one does.
    const reply = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: "hook-allow", text: "hello there" }));
    expect(await reply).toMatchObject({ text: "ok 1" });
    expect(calls).toBe(1);

    // Durable evidence: the session chain holds BOTH decisions — the hook's
    // deny (with its reason and consulted payload) and the later allow.
    if (config.sessionsDir === undefined) throw new Error("suite config always sets sessionsDir");
    const database = new Database(join(config.sessionsDir, `${denial.sessionId}.sqlite`), { readonly: true });
    try {
      const decisions = database
        .query<{ intent: string }, []>(
          "SELECT intent FROM action WHERE kind = 'policy.decision' AND json_extract(intent, '$.hook') = 'prompt.pre' ORDER BY ordinal ASC",
        )
        .all()
        .map((row) => JSON.parse(row.intent) as {
          verdict: string;
          gate?: { verdict: string; consulted: { ref: string; payload: { verdict?: string; reason?: string } }[] };
        });
      expect(decisions.map((decision) => decision.verdict)).toEqual(["deny", "allow"]);
      const denyGate = decisions[0]?.gate;
      expect(denyGate?.consulted).toEqual([
        expect.objectContaining({
          ref: Bundle.HOOK_PROCESS_REF,
          payload: expect.objectContaining({ verdict: "deny", reason: "hook_refused" }),
        }),
      ]);
      const allowGate = decisions[1]?.gate;
      expect(allowGate?.consulted).toEqual([
        expect.objectContaining({
          ref: Bundle.HOOK_PROCESS_REF,
          payload: expect.objectContaining({ verdict: "allow" }),
        }),
      ]);
    } finally {
      database.close();
    }
  } finally {
    unsubscribe();
  }
});

test("C-1: a SessionStart hook denying tools.add fails the facade configure op fail-closed", async () => {
  const dir = suite.tempDir("hooks-json-configure-");
  const script = join(dir, "configure-hook.js");
  writeFileSync(script, PROMPT_HOOK_SCRIPT);
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({
      SessionStart: [{ command: [process.execPath, script, "tools.add"], timeoutMs: 30_000 }],
    }),
  );
  const config = suite.config("hooks-json-configure-state-", { hooksPath });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      // The turn HOLDS at the model boundary: the session facade (tools.add)
      // exists only while a live turn is registered.
      run: (input: RunInput, sink: Sink) =>
        Effect.promise(async () => {
          entered.resolve();
          await release.promise;
          sink.onMessage(
            assistantMessage(input, { id: "cfg-1", text: "ok 1", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  const reply = nextResidentTurn(plane);
  ws.send(JSON.stringify({ type: "message", eventId: "cfg-1", text: "hello" }));
  await entered.promise;
  try {
    const row = plane.listSessions().find((session) => session.id !== "gateway-ingress");
    if (row === undefined) throw new Error("missing resident session");
    const handle = app.sessions.get(row.id);
    if (handle === undefined) throw new Error("missing live session");
    const before = plane.openKernel(row.id).latestGenerationFor(row.id).generation;
    // The hook consults on session.open and denies the tools.add op: the
    // facade configure fails typed, and NO generation advance is committed.
    // M-4: assert the typed failure's _tag and machine fields via Effect.flip,
    // never String(rejection).
    const refusal = await runAppEffect(app.runtime, Effect.flip(handle.tools.add([])));
    expect(refusal).toMatchObject({
      _tag: "AgentFailure",
      operation: "session.configure",
      cause: "denied",
    });
    expect(plane.openKernel(row.id).latestGenerationFor(row.id).generation).toBe(before);
  } finally {
    release.resolve();
  }
  expect(await reply).toMatchObject({ text: "ok 1" });
});

test("H-3 e2e: a UserPromptSubmit secrets-guard rewrite of body reaches the model", async () => {
  const dir = suite.tempDir("hooks-json-rewrite-");
  const hooksPath = join(dir, "hooks.json");
  // UserPromptSubmit guard defaults to the point registry's `body` field.
  writeFileSync(hooksPath, JSON.stringify({ UserPromptSubmit: [{ guard: "secrets-guard" }] }));
  const config = suite.config("hooks-json-rewrite-state-", { hooksPath });
  const seen: string[] = [];
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          seen.push(JSON.stringify(input));
          sink.onMessage(
            assistantMessage(input, { id: "rw-1", text: "done", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  const reply = nextResidentTurn(plane);
  const secret = "use sk-abcdef123456789 to call the api";
  ws.send(JSON.stringify({ type: "message", eventId: "rw-turn", text: secret }));
  expect(await reply).toMatchObject({ text: "done" });
  // The REWRITTEN body is what the model read: the secret never crossed the
  // model boundary, and the delivered turn input carries the masked bytes.
  const transcript = seen.join("\n");
  expect(transcript).toContain("[redacted]");
  expect(transcript).not.toContain("sk-abcdef123456789");
});

/** A hook that always answers a REWRITE on its consulted command (gate) row. */
const REWRITE_RESPONSE_SCRIPT = `
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const result = { type: "rewrite", fields: { body: "scrubbed" } };
    console.log(JSON.stringify({ id: request.id, result }));
  }
}
`;

test("H-3 e2e: a hook response incompatible with its row folds to deny with one recorded fact", async () => {
  const dir = suite.tempDir("hooks-json-incompatible-");
  const script = join(dir, "rewrite-hook.js");
  writeFileSync(script, REWRITE_RESPONSE_SCRIPT);
  const hooksPath = join(dir, "hooks.json");
  writeFileSync(
    hooksPath,
    JSON.stringify({
      UserPromptSubmit: [{ command: [process.execPath, script], timeoutMs: 30_000 }],
    }),
  );
  const config = suite.config("hooks-json-incompatible-state-", { hooksPath });
  let calls = 0;
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          calls += 1;
          sink.onMessage(
            assistantMessage(input, { id: "inc-1", text: "never", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  // Subscribe to the committed denial BEFORE sending (no timing luck).
  const denied = eventSignal<{ sessionId: string; id: string }>("incompatible denial", 15_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "policy.decision") return;
    const node = plane.openKernel(event.sessionId).actionById(event.id);
    const intent = node?.intent.value;
    if (intent !== null && typeof intent === "object" && !Array.isArray(intent) && intent?.verdict === "deny")
      denied.resolve({ sessionId: event.sessionId, id: event.id });
  });
  try {
    ws.send(JSON.stringify({ type: "message", eventId: "inc-turn", text: "hello" }));
    const denial = await denied.promise;
    const node = plane.openKernel(denial.sessionId).actionById(denial.id);
    const decision = z
      .object({
        verdict: z.literal("deny"),
        gate: z.looseObject({
          facts: z.array(z.looseObject({ code: z.string() })),
          consulted: z.array(z.looseObject({ ref: z.string() })),
        }),
      })
      .parse(node?.intent.value);
    // The rewrite-shaped answer on a gate row is incompatible: ONE recorded
    // fact, folded to deny — never "missing verdict => allow".
    const effect = z.looseObject({ reason: z.string() }).parse(node?.effect.value);
    expect(effect.reason).toBe("incompatible_response");
    expect(decision.gate.facts.map((fact) => fact.code)).toEqual(["incompatible_response"]);
    expect(decision.gate.consulted.map((entry) => entry.ref)).toEqual([Bundle.HOOK_PROCESS_REF]);
    // The denied prompt never reached the model.
    expect(calls).toBe(0);
  } finally {
    unsubscribe();
  }
});

test("H-3 e2e: a PreToolUse secrets-guard rewrite of bash.command reaches the executor", async () => {
  const generation = await composed({
    hooks: { PreToolUse: [{ guard: "secrets-guard", fields: ["command"] }] },
  });
  const guardHandler = generation.handlers.get(SECRETS_GUARD_REF);
  if (guardHandler === undefined || !("apply" in guardHandler) || typeof guardHandler.apply !== "function")
    throw new Error("composed secrets-guard transformer missing");
  const apply = guardHandler.apply as Core.NamedTransformer["apply"];
  const registry: Core.HandlerTable = {
    ...Core.KERNEL_POLICY_REGISTRY,
    transformers: [
      ...Core.KERNEL_POLICY_REGISTRY.transformers,
      { name: SECRETS_GUARD_REF, apply },
    ],
  };
  const seeds = gateRowPolicySeeds(
    generation.rows.filter((row) => row.id.startsWith("hooks-json/")),
  );
  await isolated(Effect.gen(function* () {
    const id = "hooks-json-bash-rewrite";
    const kernel = isolatedLedger().kernel;
    const materialized = yield* kernel.materialize({
      id, parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
      policyGeneration: 1, actionId: `${id}:configure`, at: 100,
    });
    const lease = yield* kernel.adoptFence({ sessionId: id, owner: id, fence: materialized.row.fence + 1 });
    let sequence = 0;
    const executed: string[] = [];
    const definition = Core.defineTool({
      name: "bash", description: "Run a command", category: "query",
      input: z.object({ command: z.string() }), output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async ({ command }) => { executed.push(command); return command; },
      render: (_input, output) => output,
    });
    const executor = testExecutor({
      identity: { sessionId: id, role: "resident", parentActionId: `${id}:configure` },
      clock: () => 100, entropy: () => `${id}:${++sequence}`, observations: { publish: () => undefined }, random: () => 0,
      policy: Core.compilePolicySnapshot({
        registry, generation: 1,
        rows: [
          ...Core.SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
          ...seeds.map((seed) => ({ ...seed, generation: 1 })),
        ],
      }),
      ledger: {
        ...executionReads(kernel, id),
        commit: (action) => kernel.commit({
          sessionId: id, owner: id, fence: lease.fence, now: 100,
          expectedRevision: kernel.row(id).revision,
          actions: [action], state: "running",
        }).pipe(Effect.map((result) => {
          const receipt = result.receipts[0];
          if (receipt === undefined) throw new Error("missing receipt");
          return receipt;
        })),
      },
    });
    const dispatcher = runAgentSync(
      Core.createDispatcher({ executor }).pipe(Effect.provide(catalogLayer([definition]))),
    );
    const result = yield* dispatcher.execute(
      { id: "bash-call", tool: "bash", input: { command: "curl -H 'x-key: sk-abcdef123456789' https://api" } },
      { sessionId: id, turnId: "turn" },
    );
    // The EXECUTOR received the rewritten bytes: the admitted intent row
    // carries the masked command and the original as `originalArgs`.
    expect(executed).toEqual(["curl -H 'x-key: [redacted]' https://api"]);
    expect(result).toMatchObject({ content: "curl -H 'x-key: [redacted]' https://api" });
  }));
});

/** Logs its PID at startup, then answers allow to every request. */
const PID_LOG_SCRIPT = `
const fs = require("node:fs");
fs.appendFileSync(process.argv[2], process.pid + "\\n");
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut;
  while ((cut = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    console.log(JSON.stringify({ id: request.id, result: { type: "gate", verdict: "allow" } }));
  }
}
`;

test("M-2 e2e: two rows with the same command and different timeouts spawn ONE PID in the real boot; teardown kills it", async () => {
  const dir = suite.tempDir("hooks-json-pid-");
  const script = join(dir, "pid-hook.js");
  writeFileSync(script, PID_LOG_SCRIPT);
  const pidLog = join(dir, "pids.log");
  const hooksPath = join(dir, "hooks.json");
  // One PID per distinct COMMAND per generation: timeouts are per-call
  // parameters, never pool identity (#1256 r3 M-2).
  writeFileSync(
    hooksPath,
    JSON.stringify({
      UserPromptSubmit: [
        { command: [process.execPath, script, pidLog], timeoutMs: 10_000 },
        { command: [process.execPath, script, pidLog], timeoutMs: 30_000 },
      ],
    }),
  );
  const config = suite.config("hooks-json-pid-state-", { hooksPath });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) =>
        Effect.sync(() => {
          sink.onMessage(
            assistantMessage(input, { id: "pid-1", text: "pong", createdAt: Date.now() }),
          );
          return { type: "stop" as const };
        }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, []);
  const decided = eventSignal<{ sessionId: string; id: string }>("pid-count decision", 15_000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "policy.decision") return;
    const node = plane.openKernel(event.sessionId).actionById(event.id);
    const intent = node?.intent.value;
    if (intent !== null && typeof intent === "object" && !Array.isArray(intent) && intent?.hook === "prompt.pre")
      decided.resolve({ sessionId: event.sessionId, id: event.id });
  });
  try {
    const reply = nextResidentTurn(plane);
    ws.send(JSON.stringify({ type: "message", eventId: "pid-turn", text: "ping" }));
    const decision = await decided.promise;
    expect(await reply).toMatchObject({ text: "pong" });
    // BOTH rows consulted on the one prompt decision...
    const node = plane.openKernel(decision.sessionId).actionById(decision.id);
    const parsed = z
      .looseObject({ gate: z.looseObject({ consulted: z.array(z.looseObject({ ref: z.string() })) }) })
      .parse(node?.intent.value);
    expect(parsed.gate.consulted.map((entry) => entry.ref)).toEqual([
      Bundle.HOOK_PROCESS_REF,
      Bundle.HOOK_PROCESS_REF,
    ]);
    // ...yet each live generation spawned exactly ONE PID for the command.
    // Two sessions hold a generation here (gateway-ingress + the resident), so
    // TWO distinct rows with the same command yield 2 PIDs, never 4: the pool
    // key is the command identity, not the per-call timeout (#1256 r3 M-2).
    const sessions = plane.listSessions();
    expect(sessions).toHaveLength(2);
    const pids = readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(sessions.length);
    expect(new Set(pids).size).toBe(pids.length);
    for (const pid of pids) expect(Number.isInteger(pid)).toBe(true);
    // The generation Scopes own the PIDs: teardown (the rotation finalizer
    // path) kills ALL of them.
    await suite.cleanup();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    unsubscribe();
  }
});
