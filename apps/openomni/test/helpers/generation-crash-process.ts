import { BundlesLive, GenerationLayers, session } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { Deferred, Effect } from "effect";
import { z } from "zod";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../../src/gateway";
import { AppScope } from "../../src/runtime";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { auditBundle } from "./bundle-fixture";

const [dbPath, auditPath] = z.tuple([z.string(), z.string()]).parse(process.argv.slice(2));
const audit = auditBundle(auditPath);
const runtime = gatewayRuntime({ dbPath, bundles: BundlesLive([audit.definition]) });
// IPC is subscribed before announcing the commit barrier, so the child remains
// alive until the parent delivers SIGKILL, not until a scheduling delay expires.
process.on("message", () => { throw new Error("unexpected parent command"); });
await acquireAppResource(runtime, Effect.gen(function* () {
  const generations = yield* GenerationLayers;
  yield* generations.initialize({ resident: [], worker: [] });
  seedKernelPolicyRows();
  const entered = yield* Deferred.make<void>();
  const held = yield* Deferred.make<void>();
  const handle = yield* session({ id: "crash-session", role: "resident", bundles: ["audit-log"],
    runner: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held)), Effect.as({ kind: "result" as const, text: "unused" })),
  }, {});
  yield* Effect.forkIn(handle.prompt("hold g1"), yield* AppScope);
  yield* Deferred.await(entered);
  yield* handle.system.blocks.set([{ id: "next", source: "test", content: "generation-two" }]);
}));
await runAppEffect(runtime, Effect.sync(() => {
  process.send?.({ type: "configured", generation: SessionHandleStore.latestGenerationFor("crash-session").generation,
    openTurns: SessionHandleStore.openTurns(SessionHandleStore.tree("crash-session")).length, acquisitions: audit.acquired.length });
}));
