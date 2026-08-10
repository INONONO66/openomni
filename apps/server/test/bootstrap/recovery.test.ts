import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Communication, type Wait } from "@openomni/protocol";
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

// PendingInteractionStore writes are frozen (#548) — historical rows are
// seeded at the adapter layer, exactly as pre-freeze rows persist on disk.
async function seedFrozenPendingInteractionFixture(
  id: string,
  expiresAt: number,
  lifecycle: "open" | "follow_up" = "open",
): Promise<void> {
  const session = Session.create({
    title: `${id}-session`,
    model: { providerID: "test", modelID: "test" },
  });
  // The worker-run store is frozen (#510 D2b) — the FK row is seeded at the
  // adapter layer, exactly as pre-freeze rows persist on disk.
  const workerRunAdapter = Storage.getAdapter().workerRunState;
  if (!workerRunAdapter) throw new Error("workerRunState sub-adapter missing");
  workerRunAdapter.create(session.id, {
    runId: `${id}-run`,
    agentName: "worker",
    status: "queued",
    executorKind: "internal_chat_agent",
    title: id,
    prompt: "test",
  });
  const adapter = Storage.getAdapter().pendingInteraction;
  if (!adapter) throw new Error("pendingInteraction adapter missing");
  adapter.create(
    Communication.PendingInteraction.Record.parse({
      id,
      workerRunId: `${id}-run`,
      sessionId: session.id,
      endpointId: "discord:bot-1",
      channelId: "dev",
      correlation: { replyToMessageId: `${id}-reply` },
      allowedActions: ["report_result"],
      status: lifecycle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt,
      followUpWindow: 100,
      ...(lifecycle === "follow_up" ? { resolvedAt: Date.now() - 200 } : {}),
    }),
  );
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

  it("continues boot recovery when completion recovery fails, without touching frozen rows", async () => {
    const pendingId = "pending:completion-recovery-failure";
    await seedFrozenPendingInteractionFixture(pendingId, Date.now() - 100);

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

    // #548: the store is frozen — recovery never expires pending interactions.
    expect(PendingInteractionStore.get(pendingId)?.status).toBe("open");
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
    const incidentPayloads: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    Bus.observe((event, payload) => {
      events.push(event.name);
      if (event.name === "operational.error") {
        errorPayloads.push(payload as Record<string, unknown>);
      }
      if (event.name === "operational.governor.incident") {
        incidentPayloads.push(payload as Record<string, unknown>);
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
    // #510 Done-means: the break also raises exactly one Governor incident
    // (typed, persisted telemetry for the Governor's post-hoc analysis).
    expect(incidentPayloads).toHaveLength(1);
    expect(incidentPayloads[0]).toMatchObject({
      incident: "chain_break",
      component: "server",
      context: { streamId: "wait:boot-tamper", seq: 1, code: "hash_mismatch" },
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

  it("records the frozen-store no-op receipt and never writes pending interactions (#548)", async () => {
    const infoMessages: string[] = [];
    const eventNames: string[] = [];
    Bus.observe((event, payload) => {
      eventNames.push(event.name);
      if (event.name === "operational.info") {
        infoMessages.push(String((payload as Record<string, unknown>).msg));
      }
    });
    // Stale by every pre-freeze rule: recovery must still write nothing.
    await seedFrozenPendingInteractionFixture("pi-frozen-stale", Date.now() - 1);
    await seedFrozenPendingInteractionFixture(
      "pi-frozen-follow-up",
      Date.now() + 60_000,
      "follow_up",
    );

    await runRecovery({
      handler: undefined,
      traceId: "trace-frozen-receipt",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => ({
          recovered: 0,
          skipped: 0,
          failures: [],
        }),
      },
    });

    // Frozen store (#548): the boot expiry sweep is a no-op with a receipt —
    // rows keep their persisted status and read-time expiry gates matching.
    expect(PendingInteractionStore.get("pi-frozen-stale")?.status).toBe("open");
    expect(PendingInteractionStore.get("pi-frozen-follow-up")?.status).toBe("follow_up");
    expect(eventNames).not.toContain("pending_interaction.expired");
    expect(
      infoMessages.some((msg) => msg.includes("pending-interaction") && msg.includes("frozen")),
    ).toBe(true);
  });

  it("replays interrupted inbound messages through the retry queue handler", async () => {
    const session = Session.create({
      title: "surface:retry-queue",
      model: { providerID: "test", modelID: "test" },
    });
    Session.addMessage(
      session.id,
      {
        id: "msg-retry-1",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "server-test",
        model: { providerID: "test", modelID: "test" },
      },
      { status: "processing" },
    );
    Session.addPart("msg-retry-1", {
      id: "part-retry-1",
      sessionID: session.id,
      messageID: "msg-retry-1",
      type: "text",
      text: "please finish this",
    });

    const handled: Array<{ id: string; text: string; surfaceKey: string }> = [];
    await runRecovery({
      handler: async (message) => {
        handled.push({ id: message.id, text: message.text, surfaceKey: message.surfaceKey });
      },
      traceId: "trace-retry-queue",
      completionRuntime: {
        recoverRecordedWorkItemCompletions: async () => ({
          recovered: 0,
          skipped: 0,
          failures: [],
        }),
      },
    });

    expect(handled).toEqual([
      { id: "msg-retry-1", text: "please finish this", surfaceKey: "surface:retry-queue" },
    ]);
  });

  it("swallows a throwing retry handler and finishes recovery", async () => {
    const session = Session.create({
      title: "surface:retry-throw",
      model: { providerID: "test", modelID: "test" },
    });
    Session.addMessage(
      session.id,
      {
        id: "msg-retry-throw",
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "server-test",
        model: { providerID: "test", modelID: "test" },
      },
      { status: "processing" },
    );
    Session.addPart("msg-retry-throw", {
      id: "part-retry-throw",
      sessionID: session.id,
      messageID: "msg-retry-throw",
      type: "text",
      text: "explode",
    });

    const events: string[] = [];
    const errors: string[] = [];
    Bus.observe((event, payload) => {
      events.push(event.name);
      if (event.name === "operational.error") {
        errors.push(String((payload as { msg?: unknown }).msg));
      }
    });

    await expect(
      runRecovery({
        handler: async () => {
          throw new Error("surface unavailable");
        },
        traceId: "trace-retry-throw",
        completionRuntime: {
          recoverRecordedWorkItemCompletions: async () => ({
            recovered: 0,
            skipped: 0,
            failures: [],
          }),
        },
      }),
    ).resolves.toBeUndefined();

    expect(errors.some((msg) => msg.includes("recovery retry failed for msg-retry-throw"))).toBe(
      true,
    );
    expect(events).toContain("operational.recovery.completed");
  });

  // The pre-#548 boot expiry sweep test lived here; the frozen-store no-op
  // receipt pin above replaces it. Coordinator accounting keeps its own pin:
  it("reports coordinator-recovered sessions in the completion event", async () => {
    const events: string[] = [];
    const completedPayloads: Array<Record<string, unknown>> = [];
    Bus.observe((event, data) => {
      events.push(event.name);
      if (event.name === "operational.recovery.completed") {
        completedPayloads.push(data as Record<string, unknown>);
      }
    });

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
