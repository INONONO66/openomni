import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createDefaultDispatchRuntime, type DefaultDispatchRuntime } from "@openomni/openomni";
import { Bus, PendingInteractionStore, Session, Storage, WorkerRun } from "@openomni/session";
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
