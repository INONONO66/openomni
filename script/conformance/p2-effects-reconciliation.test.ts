/**
 * #492 conformance — effect drivers + finish reconciliation over the clean
 * ledger baseline. Pins the issue's normative rows through the server
 * composition (`apps/server/src/bootstrap/effects.ts`) where the shipped
 * drivers suffice, and through instrumented fixture drivers where the
 * observation needs counters or in-flight fact assertions (rows 1 and 4):
 *
 *   1. intent(pending) -> idempotent effect -> confirmed | failed — the
 *      intent fact is durable at seq 1 BEFORE the driver acts, exactly one
 *      terminal fact lands at seq 2;
 *   2. definite failure and unknown are observably distinct (terminal fact vs
 *      outcome-less stream);
 *   3. an outcome-less intent surviving a "restart" reconciles under the SAME
 *      intent-event-id idempotency key to exactly one outcome;
 *   4. reconciliation and replays never duplicate a materialization — a
 *      divergent second outcome is refused, a same-key re-run does not
 *      re-execute the driver;
 *   5. an unmanifested kind is refused with zero facts;
 *   6. unsanitized boundary input is refused with zero facts;
 *   7. exhausted reconciliation escalates through the injected Stakes seam —
 *      the linked WorkItem gains exactly ONE durable `waiting_input` blocker
 *      (deduplicated across sweeps) and the #490 admission fold's input
 *      (`completionFacts.effects`) stays unresolved while the intent is
 *      outcome-less.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "../../packages/protocol/src/index";
import {
  EffectManifest,
  EffectReconciler,
  EffectService,
  type EffectDriver,
} from "../../packages/openomni/src/effect/index";
import {
  EffectStore,
  EffectStoreError,
  SqliteStorageAdapter,
  Storage,
  WorkItemStore,
} from "../../packages/session/src/index";
import { Bus } from "../../packages/telemetry/src/index";
import { assembleEffectRuntime } from "../../apps/server/src/bootstrap/effects";

let tempDir: string;
let inspect: Database;
let baseAdapter: SqliteStorageAdapter | undefined;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  tempDir = mkdtempSync(join(tmpdir(), "p2-effects-"));
  Storage.initialize({ dbPath: join(tempDir, "openomni.db") });
  const adapter = Storage.getAdapter();
  baseAdapter = adapter instanceof SqliteStorageAdapter ? adapter : undefined;
  inspect = new Database(join(tempDir, "openomni.db"));
});

afterEach(() => {
  inspect.close();
  baseAdapter?.close();
  baseAdapter = undefined;
  Storage.reset();
  Bus.reset();
  rmSync(tempDir, { recursive: true, force: true });
});

type FactRow = { seq: number; type: string; data: string };

function effectFactsOf(effectId: string): FactRow[] {
  return inspect
    .query("SELECT seq, type, data FROM ledger_event WHERE stream_id = ? ORDER BY seq ASC")
    .all(`effect:${effectId}`) as FactRow[];
}

async function createEffectWorkItem(name: string): Promise<WorkItem.Info> {
  const item = await WorkItemStore.create(
    {
      name,
      sourceMessageId: `msg_${name}`,
      sourceChannel: "conformance",
      intent: "verify",
      goal: "prove effect reconciliation conformance",
      sessionId: "session_effects_conformance",
      acceptanceCriteria: ["every intent reaches exactly one terminal outcome"],
    },
    "trace-test",
  );
  if (!item) throw new Error("failed to create conformance work item");
  return item;
}

describe("p2 effects conformance (#492)", () => {
  test("row 1: intent lands at seq 1 before the act; exactly one terminal fact at seq 2", async () => {
    const executions: string[] = [];
    const manifest = new EffectManifest();
    manifest.register({
      kind: "observed",
      execute: (intent) => {
        // Record-before-act: at the moment the driver runs, the intent fact
        // is already durable on the stream.
        expect(effectFactsOf(intent.effectId).map((fact) => fact.type)).toEqual([
          "effect.intended",
        ]);
        executions.push(intent.effectId);
        return { kind: "confirmed", receipt: "row-1" };
      },
      reconcile: () => ({ kind: "unknown" }),
    } satisfies EffectDriver);
    const service = new EffectService(manifest);

    const result = await service.run({ effectId: "fx-row1", kind: "observed" });
    expect(result.runtime).toBe("confirmed");
    expect(executions).toEqual(["fx-row1"]);
    expect(effectFactsOf("fx-row1").map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "effect.intended"],
      [2, "effect.confirmed"],
    ]);
  });

  test("row 2: definite failure and unknown are observably distinct", async () => {
    const { service } = assembleEffectRuntime();

    const failed = await service.run({ effectId: "fx-fail", kind: "definite-failure" });
    expect(failed.runtime).toBe("failed");
    expect(failed.ledger.materializationCount).toBe(1);
    expect(effectFactsOf("fx-fail").map((fact) => fact.type)).toEqual([
      "effect.intended",
      "effect.failed",
    ]);

    const unknown = await service.run({ effectId: "fx-unknown", kind: "unknown-result" });
    expect(unknown.runtime).toBe("unknown");
    expect(unknown.ledger.materializationCount).toBe(0);
    // No terminal fact: the intent stays outcome-less and reconcilable.
    expect(effectFactsOf("fx-unknown").map((fact) => fact.type)).toEqual(["effect.intended"]);
    expect(EffectStore.outstandingIntents().map((intent) => intent.effectId)).toContain(
      "fx-unknown",
    );
  });

  test("row 3: an outcome-less intent reconciles under the same idempotency key after restart", async () => {
    // "Restart": the intent exists on the ledger with no outcome and no
    // in-memory state survives.
    EffectStore.intend({ effectId: "fx-restart", kind: "crash-after-intent" });
    expect(EffectStore.status("fx-restart").status).toBe("pending");

    const { reconciler } = assembleEffectRuntime();
    const summary = await reconciler.reconcile("trace-test");
    expect(summary.resolved).toBe(1);

    const status = EffectStore.status("fx-restart");
    expect(status.status).toBe("confirmed");
    expect(status.materializationCount).toBe(1);
    expect(effectFactsOf("fx-restart")).toHaveLength(2);

    // Same key, second sweep: nothing outstanding, no new materialization.
    const second = await reconciler.reconcile("trace-test");
    expect(second.scanned).toBe(0);
    expect(effectFactsOf("fx-restart")).toHaveLength(2);
  });

  test("row 4: no duplicate materialization — divergent outcome refused, replay never re-executes", async () => {
    let executions = 0;
    const manifest = new EffectManifest();
    manifest.register({
      kind: "count-executions",
      execute: () => {
        executions += 1;
        return { kind: "confirmed", receipt: "first" };
      },
      reconcile: () => ({ kind: "confirmed", receipt: "probe" }),
    });
    const service = new EffectService(manifest);

    await service.run({ effectId: "fx-dup", kind: "count-executions" });
    const replay = await service.run({ effectId: "fx-dup", kind: "count-executions" });
    expect(replay.runtime).toBe("confirmed");
    expect(executions).toBe(1); // the replay reported the recorded outcome, no second act
    expect(effectFactsOf("fx-dup")).toHaveLength(2);

    // A divergent second outcome on the same stream is a typed refusal.
    expect(() => EffectStore.fail("fx-dup", "divergent overwrite")).toThrow(EffectStoreError);
    expect(effectFactsOf("fx-dup")).toHaveLength(2);
  });

  test("rows 5+6: unmanifested kinds and unsanitized input are refused with zero facts", async () => {
    const { service } = assembleEffectRuntime();

    await expect(
      service.run({ effectId: "fx-unmanifested", kind: "not-a-kind" }),
    ).rejects.toMatchObject({ code: "unmanifested_request", materializationCount: 0 });
    expect(effectFactsOf("fx-unmanifested")).toHaveLength(0);

    await expect(
      service.run({ effectId: "fx-unsanitized", kind: "manual", input: "../../etc/passwd" }),
    ).rejects.toMatchObject({ code: "unsanitized_input", materializationCount: 0 });
    expect(effectFactsOf("fx-unsanitized")).toHaveLength(0);
  });

  test("row 8: crash between terminal fact and link — boot sweep re-projects and unblocks admission", async () => {
    const item = await createEffectWorkItem("effect-crash-window");

    // The #538 crash window: intent + pending projection + terminal fact all
    // land, but the terminal WorkItem projection (a separate, later tx) never
    // ran — so the effect stream says confirmed while completionFacts.effects
    // (the admission fold's only input) is stuck outcome-less.
    EffectStore.intend({ effectId: "fx-crash", kind: "manual", workItemHash: item.hash });
    WorkItemStore.recordEffect(item.hash, { intentRef: "fx-crash" });
    EffectStore.confirm("fx-crash", "receipt");

    const stuck = await WorkItemStore.get(item.hash);
    const stuckLatest = stuck?.completionFacts.effects
      .filter((effect) => effect.intentRef === "fx-crash")
      .at(-1);
    expect(stuckLatest?.outcome).toBeUndefined();
    // outstandingIntents excludes the terminal stream — the probe loop can't heal it.
    expect(EffectStore.outstandingIntents().map((intent) => intent.effectId)).not.toContain(
      "fx-crash",
    );

    // The boot sweep alone (no replay) re-projects the ALREADY-RECORDED outcome.
    const { reconciler } = assembleEffectRuntime();
    const summary = await reconciler.reconcile("trace-test");
    expect(summary.reprojected).toBe(1);
    expect(summary.resolved).toBe(0);

    const healed = await WorkItemStore.get(item.hash);
    const healedLatest = healed?.completionFacts.effects
      .filter((effect) => effect.intentRef === "fx-crash")
      .at(-1);
    expect(healedLatest?.outcome).toBe("confirmed");
    // Nothing re-materialized on the stream: still exactly intent + one terminal.
    expect(effectFactsOf("fx-crash").map((fact) => fact.type)).toEqual([
      "effect.intended",
      "effect.confirmed",
    ]);

    // Idempotent across every boot: a healed WorkItem is not re-linked again.
    const second = await reconciler.reconcile("trace-test");
    expect(second.reprojected).toBe(0);
  });

  test("row 7: exhaustion escalates via the Stakes seam — ONE durable blocker, admission input unresolved", async () => {
    const item = await createEffectWorkItem("effect-escalation");

    // Through the server composition: the shipped exhausting-probe scenario
    // driver and the shipped escalation seam, exactly as boot wires them.
    const { service, reconciler, manifest } = assembleEffectRuntime();
    const result = await service.run({
      effectId: "fx-exhaust",
      kind: "exhausting-probe",
      workItemHash: item.hash,
    });
    expect(result.runtime).toBe("unknown");

    // #490 linkage: the outcome-less intent rides completionFacts.effects —
    // the exact input the admission fold blocks on (`effect_outcome_unresolved`).
    const linked = await WorkItemStore.get(item.hash);
    expect(
      linked?.completionFacts.effects.some(
        (effect) => effect.intentRef === "fx-exhaust" && effect.outcome === "unknown",
      ),
    ).toBe(true);

    // kernel-contract §retry policy: exhausted reconciliation adds a
    // waiting_input blocker instead of terminalizing.
    const summary = await reconciler.reconcile("trace-test");
    expect(summary.escalated).toBe(1);
    expect(summary.resolved).toBe(0);

    const escalated = await WorkItemStore.get(item.hash);
    const blockers = escalated?.blockers.filter((entry) => entry.kind === "waiting_input") ?? [];
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.id).toBe("effect-escalation:fx-exhaust");
    expect(blockers[0]?.description).toContain("fx-exhaust");

    // Re-escalation across sweeps (every boot) must NOT stack blockers.
    await reconciler.reconcile("trace-test");
    await reconciler.reconcile("trace-test");
    const afterSweeps = await WorkItemStore.get(item.hash);
    expect(afterSweeps?.blockers.filter((entry) => entry.kind === "waiting_input")).toHaveLength(1);

    // Never terminalized: the intent is still outcome-less and reconcilable.
    expect(EffectStore.status("fx-exhaust").status).toBe("pending");
    expect(effectFactsOf("fx-exhaust")).toHaveLength(1);

    // Fail-closed without a seam: the same exhaustion with no escalation
    // wiring throws rather than silently terminalizing.
    const bare = new EffectReconciler(manifest);
    await expect(bare.reconcile("trace-test")).rejects.toThrow(/no escalation seam/);
  });
});
