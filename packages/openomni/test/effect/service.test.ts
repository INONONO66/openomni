import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkItem } from "@openomni/protocol";
import { EffectStore, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/session";
import {
  EffectManifest,
  EffectRefusal,
  EffectReconciler,
  EffectService,
  type EffectDriver,
  type EffectExecution,
  type EffectIntent,
} from "../../src/effect/index.js";
import { evaluateCompletion } from "../../src/work-item/completion-admission-fold.js";

let adapter: SqliteStorageAdapter | undefined;

beforeEach(() => {
  adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
});

afterEach(() => {
  Storage.reset();
  adapter?.close();
  adapter = undefined;
});

/** A programmable driver: `execute`/`reconcile` return whatever is queued, recording calls. */
class ScriptedDriver implements EffectDriver {
  readonly replay = "never" as const;
  executeCalls = 0;
  reconcileCalls = 0;
  constructor(
    readonly kind: string,
    private readonly onExecute: EffectExecution,
    private readonly onReconcile: EffectExecution = onExecute,
  ) {}
  execute(): EffectExecution {
    this.executeCalls += 1;
    return this.onExecute;
  }
  reconcile(_intent: EffectIntent): EffectExecution {
    this.reconcileCalls += 1;
    return this.onReconcile;
  }
}

function manifestWith(
  driver: EffectDriver,
  sanitize?: (input: unknown) => unknown,
): EffectManifest {
  const manifest = new EffectManifest();
  manifest.register(driver, sanitize);
  return manifest;
}

describe("EffectService", () => {
  test("fresh intent: records intent, executes, then records the terminal outcome", async () => {
    const driver = new ScriptedDriver("http.post", { kind: "confirmed", receipt: "ok-1" });
    const service = new EffectService(manifestWith(driver));

    const result = await service.run({ effectId: "e1", kind: "http.post" });

    expect(driver.executeCalls).toBe(1);
    expect(result.runtime).toBe("confirmed");
    expect(result.ledger.status).toBe("confirmed");
    expect(result.ledger.materializationCount).toBe(1);
  });

  test("unmanifested kind is refused BEFORE any ledger write", async () => {
    const service = new EffectService(new EffectManifest());

    let refusal: EffectRefusal | undefined;
    try {
      await service.run({ effectId: "e-none", kind: "unknown.kind" });
    } catch (error) {
      if (error instanceof EffectRefusal) refusal = error;
    }
    expect(refusal?.code).toBe("unmanifested_request");
    expect(refusal?.materializationCount).toBe(0);
    // No intent was recorded — the boundary ran before record-before-act.
    expect(EffectStore.status("e-none").status).toBe("absent");
  });

  test("unsanitized input is refused with zero materialization", async () => {
    const driver = new ScriptedDriver("fs.write", { kind: "confirmed" });
    const service = new EffectService(
      manifestWith(driver, (input) => {
        if (typeof input === "string" && input.includes("..")) {
          throw new EffectRefusal("unsanitized_input", "path traversal rejected", "fs.write");
        }
        return input;
      }),
    );

    let code: string | undefined;
    try {
      await service.run({ effectId: "e-bad", kind: "fs.write", input: "../../etc/passwd" });
    } catch (error) {
      if (error instanceof EffectRefusal) code = error.code;
    }
    expect(code).toBe("unsanitized_input");
    expect(driver.executeCalls).toBe(0);
    expect(EffectStore.status("e-bad").status).toBe("absent");
  });

  test("unknown outcome records NO terminal fact — the intent stays reconcilable", async () => {
    const driver = new ScriptedDriver("http.post", { kind: "unknown", reason: "timeout" });
    const service = new EffectService(manifestWith(driver));

    const result = await service.run({ effectId: "e-unknown", kind: "http.post" });

    expect(result.runtime).toBe("unknown");
    expect(result.ledger.status).toBe("pending");
    expect(EffectStore.outstandingIntents().map((i) => i.effectId)).toContain("e-unknown");
  });

  test("replay of a pending intent reconciles instead of re-executing", async () => {
    // First run leaves it unknown (outcome-less, pending on the ledger).
    const driver = new ScriptedDriver(
      "http.post",
      { kind: "unknown", reason: "timeout" },
      { kind: "confirmed", receipt: "probed" },
    );
    const service = new EffectService(manifestWith(driver));

    await service.run({ effectId: "e-replay", kind: "http.post" });
    const replay = await service.run({ effectId: "e-replay", kind: "http.post" });

    expect(driver.executeCalls).toBe(1); // never re-executed
    expect(driver.reconcileCalls).toBe(1); // probed instead
    expect(replay.runtime).toBe("confirmed");
    expect(EffectStore.status("e-replay").status).toBe("confirmed");
  });

  test("replay of a terminal intent returns the recorded outcome without touching the driver", async () => {
    const driver = new ScriptedDriver("http.post", { kind: "confirmed", receipt: "ok" });
    const service = new EffectService(manifestWith(driver));

    await service.run({ effectId: "e-term", kind: "http.post" });
    const replay = await service.run({ effectId: "e-term", kind: "http.post" });

    expect(driver.executeCalls).toBe(1);
    expect(driver.reconcileCalls).toBe(0);
    expect(replay.runtime).toBe("confirmed");
  });
});

describe("EffectReconciler", () => {
  function seedOutstanding(effectId: string, kind = "http.post"): void {
    EffectStore.intend({ effectId, kind });
  }

  test("resolves outstanding intents by probing the world (confirm)", async () => {
    seedOutstanding("r1");
    const driver = new ScriptedDriver(
      "http.post",
      { kind: "confirmed" },
      { kind: "confirmed", receipt: "probe" },
    );
    const summary = await new EffectReconciler(manifestWith(driver)).reconcile("trace-test");

    expect(summary).toEqual({
      scanned: 1,
      resolved: 1,
      stillUnknown: 0,
      escalated: 0,
      reprojected: 0,
    });
    expect(EffectStore.status("r1").status).toBe("confirmed");
  });

  test("leaves still-unknown intents outcome-less for the next sweep", async () => {
    seedOutstanding("r2");
    const driver = new ScriptedDriver(
      "http.post",
      { kind: "unknown" },
      { kind: "unknown", reason: "still down" },
    );
    const summary = await new EffectReconciler(manifestWith(driver)).reconcile("trace-test");

    expect(summary.resolved).toBe(0);
    expect(summary.stillUnknown).toBe(1);
    expect(EffectStore.status("r2").status).toBe("pending");
  });

  test("exhausted reconciliation escalates by the injected seam — never terminalizes", async () => {
    seedOutstanding("r3");
    const driver = new ScriptedDriver(
      "http.post",
      { kind: "unknown" },
      { kind: "unknown", reason: "gave up", exhausted: true },
    );
    const escalations: string[] = [];
    const summary = await new EffectReconciler(manifestWith(driver), (intent, detail) => {
      escalations.push(`${intent.effectId}:${detail}`);
    }).reconcile("trace-test");

    expect(summary.escalated).toBe(1);
    expect(escalations).toEqual(["r3:gave up"]);
    // No terminal fact was forced — it stays reconcilable.
    expect(EffectStore.status("r3").status).toBe("pending");
  });

  test("exhaustion with no escalation seam fails closed (throws, never terminalizes)", async () => {
    seedOutstanding("r4");
    const driver = new ScriptedDriver(
      "http.post",
      { kind: "unknown" },
      { kind: "unknown", exhausted: true },
    );

    let threw = false;
    try {
      await new EffectReconciler(manifestWith(driver)).reconcile("trace-test");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(EffectStore.status("r4").status).toBe("pending");
  });
});

describe("effect ↔ completion admission linkage (#490)", () => {
  async function linkedWorkItem(): Promise<string> {
    const item = await WorkItemStore.create(
      {
        name: "effect gated work",
        sourceMessageId: "msg-gate",
        sourceChannel: "test",
        intent: "verification",
        goal: "gate completion on an effect",
        sessionId: "session-gate",
        acceptanceCriteria: ["side effect confirmed"],
      },
      "trace-test",
    );
    return item.workItemId;
  }

  function foldDecision(hash: string): WorkItem.CompletionAdmission {
    const item = WorkItemStore.get(hash);
    if (!item) throw new Error("work item vanished");
    return evaluateCompletion({
      admissionId: "adm-1",
      requestId: "req-1",
      requestRoot: "root-1",
      origin: "worker",
      workItemHash: hash,
      contractRevision: "c1",
      basisRef: item.completionContract.basisRef,
      expectedHead: item.revision,
      createdAt: Date.now(),
      durableFacts: item.completionFacts,
      proposedFacts: {
        claims: [],
        observations: [],
        results: [],
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
      blockers: [],
      currentAttempt: item.attempt,
      policy: {
        policyRef: "p1",
        verdict: "allow",
        allowedAssertedCriterionIds: [],
        reasonCodes: [],
      },
    });
  }

  function latestEffectOutcome(hash: string, intentRef: string): string | undefined {
    const item = WorkItemStore.get(hash);
    let latest: WorkItem.EffectRecord | undefined;
    for (const record of item?.completionFacts.effects ?? []) {
      if (record.intentRef !== intentRef) continue;
      if (!latest || record.createdAt >= latest.createdAt) latest = record;
    }
    return latest?.outcome;
  }

  /**
   * The #538 crash window: the intent and its pending WorkItem projection land,
   * the terminal fact commits on the effect stream (tx A), but the LATER
   * terminal projection (tx B) never runs — so admission is stuck on an
   * outcome-less EffectRecord while the ledger says the effect is done.
   */
  function crashWindow(hash: string, effectId: string, kind = "http.post"): void {
    EffectStore.intend({ effectId, kind, workItemHash: hash });
    WorkItemStore.recordEffect(hash, { intentRef: effectId }); // pending projection only
    EffectStore.confirm(effectId, "landed"); // terminal fact — crash BEFORE tx B
  }

  test("seam (b): terminal replay re-projects the crash-window outcome and unblocks admission", async () => {
    const hash = await linkedWorkItem();
    crashWindow(hash, "e-crash-replay");

    // Precondition: the ledger is terminal but admission is stuck forever.
    expect(EffectStore.status("e-crash-replay").status).toBe("confirmed");
    expect(latestEffectOutcome(hash, "e-crash-replay")).toBeUndefined();
    expect(foldDecision(hash).reasonCodes).toContain("effect_outcome_unresolved");

    // Re-running the same effectId (replay) must re-project WITHOUT re-executing.
    const driver = new ScriptedDriver("http.post", { kind: "confirmed", receipt: "ok" });
    const replay = await new EffectService(manifestWith(driver)).run({
      effectId: "e-crash-replay",
      kind: "http.post",
      workItemHash: hash,
    });

    expect(replay.runtime).toBe("confirmed");
    expect(driver.executeCalls).toBe(0); // terminal replay never re-executes
    expect(driver.reconcileCalls).toBe(0);
    expect(latestEffectOutcome(hash, "e-crash-replay")).toBe("confirmed");
    expect(foldDecision(hash).reasonCodes).not.toContain("effect_outcome_unresolved");
  });

  test("seam (a): boot reconcile re-links a crash-window terminal intent without replay", async () => {
    const hash = await linkedWorkItem();
    crashWindow(hash, "e-crash-sweep");
    expect(foldDecision(hash).reasonCodes).toContain("effect_outcome_unresolved");

    // No replay: the boot sweep alone re-projects the recorded terminal outcome.
    // The intent is terminal, so it is NOT outstanding and the driver's probe
    // must never be consulted — the pass only reads already-recorded facts.
    const driver = new ScriptedDriver("http.post", { kind: "unknown" });
    const summary = await new EffectReconciler(manifestWith(driver)).reconcile("trace-test");

    expect(summary.reprojected).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(driver.reconcileCalls).toBe(0);
    expect(latestEffectOutcome(hash, "e-crash-sweep")).toBe("confirmed");
    expect(foldDecision(hash).reasonCodes).not.toContain("effect_outcome_unresolved");

    // Idempotent across sweeps: a healed WorkItem is not re-linked again.
    const second = await new EffectReconciler(manifestWith(driver)).reconcile("trace-test");
    expect(second.reprojected).toBe(0);
  });

  test("a pending effect blocks completion; confirming it unblocks", async () => {
    const hash = await linkedWorkItem();
    const driver = new ScriptedDriver(
      "http.post",
      { kind: "unknown", reason: "pending" },
      { kind: "confirmed", receipt: "done" },
    );
    const service = new EffectService(manifestWith(driver));

    // Fresh run leaves the effect unknown → a pending EffectRecord blocks.
    await service.run({ effectId: "e-gate", kind: "http.post", workItemHash: hash });
    const blocked = foldDecision(hash);
    expect(blocked.reasonCodes).toContain("effect_outcome_unresolved");
    expect(blocked.decision).toBe("block");

    // Reconcile probes and confirms → the terminal EffectRecord clears the
    // effect gate specifically (the work item's own acceptance criteria are a
    // separate gate this leaf does not own).
    await service.run({ effectId: "e-gate", kind: "http.post", workItemHash: hash });
    const cleared = foldDecision(hash);
    expect(cleared.reasonCodes).not.toContain("effect_outcome_unresolved");
  });
});
