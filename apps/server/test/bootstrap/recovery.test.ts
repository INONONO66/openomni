import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { Wait } from "@openomni/protocol";
import {
  createDefaultDispatchRuntime,
  WaitService,
  type DefaultDispatchRuntime,
} from "@openomni/openomni";
import {
  Bus,
  EffectStore,
  PendingInteractionStore,
  Session,
  Storage,
  WaitStore,
  WorkerRun,
} from "@openomni/session";
import { assembleEffectRuntime } from "../../src/bootstrap/effects";
import { runRecovery, startInboundSurfacesAfterRecovery } from "../../src/bootstrap/recovery";

let completionWriter: Storage.WorkItemCompletionWriter;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  completionWriter = Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

async function createPendingInteractionFixture(
  id: string,
  expiresAt: number,
  lifecycle: "open" | "follow_up" = "open",
): Promise<void> {
  const session = Session.create({
    title: `${id}-session`,
    model: { providerID: "test", modelID: "test" },
  });
  await WorkerRun.create(session.id, { runId: `${id}-run`, title: id, prompt: "test" });
  PendingInteractionStore.create({
    id,
    workerRunId: `${id}-run`,
    sessionId: session.id,
    endpointId: "discord:bot-1",
    channelId: "dev",
    correlation: { replyToMessageId: `${id}-reply` },
    allowedActions: ["report_result"],
    expiresAt,
    followUpWindow: 100,
    ...(lifecycle === "follow_up"
      ? {
          status: "follow_up" as const,
          resolvedAt: Date.now() - 200,
        }
      : {}),
  });
}

describe("server recovery", () => {
  it("injects the public default runtime into recovery before inbound surfaces start", async () => {
    const runtime = createDefaultDispatchRuntime({ completionWriter });
    let recoveredRuntime:
      | Pick<DefaultDispatchRuntime, "recoverRecordedWorkItemCompletions">
      | undefined;
    const events: string[] = [];

    const server = await startInboundSurfacesAfterRecovery({
      recover: async () => {
        events.push("recovery");
        recoveredRuntime = runtime;
        await runRecovery({
          handler: undefined,
          traceId: "trace-bootstrap-wiring",
          completionRuntime: runtime,
        });
      },
      createServer: () => {
        events.push("server");
        return { close: () => undefined };
      },
      channels: [
        {
          start() {
            events.push("channel");
          },
        },
      ],
    });

    expect(recoveredRuntime).toBe(runtime);
    expect(events).toEqual(["recovery", "server", "channel"]);
    expect(server).toEqual({ close: expect.any(Function) });
  });

  it("invokes recorded WorkItem completion recovery during boot", async () => {
    let completionRecoveryCalls = 0;

    await runRecovery({
      handler: undefined,
      traceId: "trace-completion-recovery",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => {
          completionRecoveryCalls += 1;
          return { recovered: 1, skipped: 0, failures: [] };
        },
      },
    });

    expect(completionRecoveryCalls).toBe(1);
  });

  it("continues pending-interaction cleanup when completion recovery fails", async () => {
    const pendingId = "pending:completion-recovery-failure";
    await createPendingInteractionFixture(pendingId, Date.now() - 100);

    await expect(
      runRecovery({
        handler: undefined,
        traceId: "trace-completion-recovery-failure",
        completionRuntime: {
          recoverRecordedWorkItemCompletions: async () => {
            throw new Error("completion recovery failed");
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(PendingInteractionStore.get(pendingId)?.status).toBe("expired");
  });

  it("surfaces each failed WorkItem completion resume as its own loud Operational.Error", async () => {
    const errorPayloads: Array<Record<string, unknown>> = [];
    Bus.observe((event, payload) => {
      if (event.name === "operational.error") {
        errorPayloads.push(payload as Record<string, unknown>);
      }
    });

    await runRecovery({
      handler: undefined,
      traceId: "trace-completion-failure-loud",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => ({
          recovered: 0,
          skipped: 0,
          failures: [
            {
              workItemHash: "wi_stale_head",
              admissionId: "admission-1",
              error: "completion admission head does not match 3",
            },
          ],
        }),
      },
    });
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    const failure = errorPayloads.find((payload) => String(payload.msg).includes("wi_stale_head"));
    expect(failure?.msg).toBe(
      "recovery failed to resume recorded WorkItem completion: wi_stale_head",
    );
    expect(failure?.context).toMatchObject({
      workItemHash: "wi_stale_head",
      admissionId: "admission-1",
      error: "completion admission head does not match 3",
    });
  });

  it("completes boot recovery when the expiry sweep meets one corrupt wait", async () => {
    const buildWaitCreate = (id: string): Wait.Create => ({
      id,
      ownerRef: { kind: "session", id: `session-${id}` },
      originMessageId: `out-${id}`,
      correlation: { tokenHash: `tok-${id}` },
      allowedActions: ["report_result"],
      expectedResponders: ["actor-a"],
      resolutionPolicy: "first_reply",
      expiresAt: Date.now() - 1,
      followUpWindow: 1_000,
    });
    WaitService.open(buildWaitCreate("wait-boot-corrupt"));
    WaitService.open(buildWaitCreate("wait-boot-healthy"));
    // Corrupt one wait's owner stream: an extra fact advances the head past
    // the projected revision, so its expiry transition conflicts forever.
    const appended = Storage.getAdapter().ledger?.append(
      { streamId: "wait:wait-boot-corrupt", type: "wait.tampered", data: {} },
      1,
    );
    expect(appended?.kind).toBe("appended");

    const events: string[] = [];
    const errorPayloads: Array<Record<string, unknown>> = [];
    Bus.observe((event, payload) => {
      events.push(event.name);
      if (event.name === "operational.error") {
        errorPayloads.push(payload as Record<string, unknown>);
      }
    });

    await expect(
      runRecovery({
        handler: undefined,
        traceId: "trace-corrupt-wait",
        completionRuntime: {
          recoverRecordedWorkItemCompletions: async () => ({
            recovered: 0,
            skipped: 0,
            failures: [],
          }),
        },
      }),
    ).resolves.toBeUndefined();

    // One bad wait never kills boot (#510 review fix F3): recovery completed,
    // the healthy wait expired, and the corrupt one was recorded loudly.
    expect(events).toContain("operational.recovery.completed");
    expect(WaitStore.get("wait-boot-healthy")?.status).toBe("expired");
    expect(WaitStore.get("wait-boot-corrupt")?.status).toBe("open");
    expect(
      errorPayloads.some((payload) =>
        String(payload.msg).includes("wait expiry sweep failed for wait-boot-corrupt"),
      ),
    ).toBe(true);
  });

  it("records a ledger chain-break at boot and continues (does not refuse boot)", async () => {
    const adapter = Storage.getAdapter();
    const outcome = adapter.ledger?.append(
      { streamId: "wait:boot-tamper", type: "wait.created", data: { note: "boot" } },
      0,
    );
    expect(outcome?.kind).toBe("appended");

    // Tamper with the stored fact on the storage connection: the recomputed
    // hash no longer matches the recorded event_hash.
    const descriptor = Object.getOwnPropertyDescriptor(adapter, "db");
    if (!(descriptor?.value instanceof Database)) {
      throw new Error("expected a SQLite-backed storage adapter");
    }
    descriptor.value
      .query("UPDATE ledger_event SET data = ? WHERE stream_id = ?")
      .run(JSON.stringify({ note: "tampered" }), "wait:boot-tamper");

    const errorPayloads: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    Bus.observe((event, payload) => {
      events.push(event.name);
      if (event.name === "operational.error") {
        errorPayloads.push(payload as Record<string, unknown>);
      }
    });

    await runRecovery({
      handler: undefined,
      traceId: "trace-chain-break",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => ({
          recovered: 0,
          skipped: 0,
          failures: [],
        }),
      },
    });

    const chainBreakError = errorPayloads.find((payload) =>
      String(payload.msg).includes("ledger chain-break detected at boot"),
    );
    expect(chainBreakError?.msg).toBe(
      "ledger chain-break detected at boot: wait:boot-tamper seq 1 (hash_mismatch)",
    );
    expect(chainBreakError?.context).toMatchObject({
      streamId: "wait:boot-tamper",
      seq: 1,
      code: "hash_mismatch",
    });
    // Boot proceeds: recovery completed despite the recorded break.
    expect(events).toContain("operational.recovery.completed");
  });

  it("records a LOUD Operational.Error when the adapter lacks the ledger sub-adapter", async () => {
    // AGENTS.md rule 7 pin: an optional sub-adapter is test-fake-only — its
    // absence in a boot path must surface as an error, never as a silent
    // empty verification result.
    const { ledger: _ledger, ...withoutLedger } = Storage.getAdapter();
    Storage.configure(withoutLedger);

    const errorPayloads: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    Bus.observe((event, payload) => {
      events.push(event.name);
      if (event.name === "operational.error") {
        errorPayloads.push(payload as Record<string, unknown>);
      }
    });

    await runRecovery({
      handler: undefined,
      traceId: "trace-ledger-absent",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => ({
          recovered: 0,
          skipped: 0,
          failures: [],
        }),
      },
    });

    const absenceError = errorPayloads.find((payload) =>
      String(payload.msg).includes("ledger tail verification failed at boot"),
    );
    expect(absenceError?.context).toMatchObject({
      error: "storage adapter does not implement ledger reads — tail verification skipped",
    });
    // Observe-only surface: the error is loud but boot still completes.
    expect(events).toContain("operational.recovery.completed");
  });

  it("expires stale PendingInteractions during boot recovery", async () => {
    const events: string[] = [];
    const completedPayloads: Array<Record<string, unknown>> = [];
    Bus.observe((event, data) => {
      events.push(event.name);
      if (event.name === "operational.recovery.completed") {
        completedPayloads.push(data as Record<string, unknown>);
      }
    });
    await createPendingInteractionFixture("pi-boot-expired", Date.now() - 1);
    await createPendingInteractionFixture(
      "pi-boot-follow-up-expired",
      Date.now() + 60_000,
      "follow_up",
    );
    await createPendingInteractionFixture("pi-boot-active", Date.now() + 60_000);

    await runRecovery({
      handler: undefined,
      coordinator: {
        recoverInterruptedRuns: async () => ({ recovered: 3, sessions: ["s-1", "s-2"] }),
      },
      traceId: "trace-recovery",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => ({
          recovered: 0,
          skipped: 0,
          failures: [],
        }),
      },
    });

    expect(PendingInteractionStore.get("pi-boot-expired")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-boot-follow-up-expired")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-boot-active")?.status).toBe("open");
    expect(events).toContain("pending_interaction.expired");
    expect(events).toContain("operational.recovery.completed");
    expect(completedPayloads[0]?.sessionsRecovered).toBe(2);
  });
});

describe("boot effect reconciliation (#492)", () => {
  const stubCompletionRuntime = {
    recoverRecordedWorkItemCompletions: async () => ({
      recovered: 0,
      skipped: 0,
      failures: [],
    }),
  };

  it("resolves an outcome-less crash-window intent at boot under its idempotency key", async () => {
    const runtime = assembleEffectRuntime();
    // Simulate the crash window: the intent landed, the outcome never did.
    EffectStore.intend({ effectId: "fx-boot-1", kind: "crash-after-intent" });
    expect(EffectStore.status("fx-boot-1").status).toBe("pending");

    await runRecovery({
      handler: undefined,
      traceId: "trace-effect-boot",
      completionRuntime: stubCompletionRuntime,
      effects: runtime.reconciler,
    });

    const status = EffectStore.status("fx-boot-1");
    expect(status.status).toBe("confirmed");
    expect(status.materializationCount).toBe(1);
  });

  it("runs the effect sweep before recorded WorkItem completions resume", async () => {
    const order: string[] = [];
    await runRecovery({
      handler: undefined,
      traceId: "trace-effect-order",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => {
          order.push("completion");
          return { recovered: 0, skipped: 0, failures: [] };
        },
      },
      effects: {
        reconcile: async () => {
          order.push("effects");
          return { scanned: 0, resolved: 0, stillUnknown: 0, escalated: 0 };
        },
      },
    });
    expect(order).toEqual(["effects", "completion"]);
  });

  it("treats an effect sweep failure as observe-only: loud error, boot proceeds", async () => {
    const errors: string[] = [];
    Bus.observe((event, payload) => {
      if (event.name === "operational.error") {
        errors.push(String((payload as { msg?: unknown }).msg));
      }
    });

    let completionRan = false;
    await expect(
      runRecovery({
        handler: undefined,
        traceId: "trace-effect-sweep-failure",
        completionRuntime: {
          recoverRecordedWorkItemCompletions: async () => {
            completionRan = true;
            return { recovered: 0, skipped: 0, failures: [] };
          },
        },
        effects: {
          reconcile: async () => {
            throw new Error("probe blew up");
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(completionRan).toBe(true);
    expect(errors.some((msg) => msg.includes("effect reconciliation failed at boot"))).toBe(true);
  });
});
