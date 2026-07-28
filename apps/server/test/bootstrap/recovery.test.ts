import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Bus, PendingInteractionStore, Session, Storage, WorkerRun } from "@openomni/session";
import { runRecovery } from "../../src/bootstrap/recovery";

const bootstrapSource = await Bun.file(
  new URL("../../src/bootstrap/index.ts", import.meta.url),
).text();

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
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

    await runRecovery(
      undefined,
      { recoverInterruptedRuns: async () => ({ recovered: 3, sessions: ["s-1", "s-2"] }) },
      "trace-recovery",
    );

    expect(PendingInteractionStore.get("pi-boot-expired")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-boot-follow-up-expired")?.status).toBe("expired");
    expect(PendingInteractionStore.get("pi-boot-active")?.status).toBe("open");
    expect(events).toContain("pending_interaction.expired");
    expect(events).toContain("operational.recovery.completed");
    // #477 review W4: the completed event must carry the recovered session
    // count from RecoveryResult.sessions, not a number-coerced 0.
    expect(completedPayloads[0]?.sessionsRecovered).toBe(2);
  });

  it("runs recovery before inbound dispatch surfaces start", () => {
    const recoveryIndex = bootstrapSource.indexOf("await runRecovery(");
    const serveIndex = bootstrapSource.indexOf("Bun.serve(");
    const channelStartIndex = bootstrapSource.indexOf("channel.start()");

    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(serveIndex).toBeGreaterThan(-1);
    expect(channelStartIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeLessThan(serveIndex);
    expect(recoveryIndex).toBeLessThan(channelStartIndex);
  });
});
