import { sessionTree } from "../../../packages/ledger/test/helpers/session-tree";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { BundlesLive, GenerationLayers, SessionLayer } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { Effect } from "effect";
import { z } from "zod";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { auditBundle } from "./helpers/bundle-fixture";
import { eventSignal } from "./helpers/event-signal";
import { residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();
const Configured = z.object({ type: z.literal("configured"), generation: z.number(), openTurns: z.number(), acquisitions: z.number() });

test("G1 prerequisite: SIGKILL at committed configure rearms current and recorded older generations", async () => {
  const directory = suite.tempDir("generation-crash-");
  const dbPath = join(directory, "app.sqlite");
  const auditPath = join(directory, "audit.jsonl");
  const committed = eventSignal<z.infer<typeof Configured>>("post-configure commit");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/generation-crash-process.ts"), dbPath, auditPath], {
    stdout: "pipe", stderr: "pipe",
    ipc: (message) => committed.resolve(Configured.parse(message)),
  });
  const exited = child.exited;
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  try {
    expect(await committed.promise).toEqual({ type: "configured", generation: 2, openTurns: 1, acquisitions: 2 });
    child.kill("SIGKILL");
    await exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await stderr).toBe("");
    await stdout;
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await exited; } }
  const audit = auditBundle(auditPath);
  const runtime = gatewayRuntime({ dbPath, bundles: BundlesLive([audit.definition]) });
  try {
    const snapshots = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      yield* generations.initialize({ resident: [], worker: [] });
      const current = SessionHandleStore.latestGenerationFor("crash-session");
      const open = SessionHandleStore.openTurns(sessionTree("crash-session"));
      expect(open).toHaveLength(1);
      const recorded = open[0];
      if (recorded === undefined) throw new Error("missing recorded open turn");
      const latest = yield* generations.capture({ sessionId: "crash-session", generation: current.generation });
      const previous = yield* generations.capture({ sessionId: "crash-session", generation: recorded.toolsGeneration });
      return [yield* latest.provide(SessionLayer), yield* previous.provide(SessionLayer)];
    })));
    expect(snapshots.map((layer) => layer.snapshot.generation)).toEqual([2, 1]);
    expect(snapshots[0]?.snapshot.systemValue).toContain("generation-two");
    expect(snapshots[1]?.snapshot.systemValue).not.toContain("generation-two");
    expect(audit.acquired).toHaveLength(2);
    console.log(JSON.stringify({ case: "G1-prerequisite", volatileScopes: "not_durable", reconstructedResources: "rearmed", generations: [2, 1] }));
  } finally { await runtime.dispose(); }
  expect(audit.closed.sort()).toEqual(audit.acquired.sort());
});
