import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { Bus } from "@openomni/agent";
import { LedgerWrites, SessionHandleStore, Storage, type CommitReceipt } from "@openomni/ledger";
import type { LedgerSession } from "@openomni/protocol";
import { createAlarmWorker } from "../src/composition/alarm-worker";
import { createIngressExecutor } from "../src/composition/ingress-executor";
import { messageMaterialization, prepareMessage } from "../src/composition/message-session";
import { acquireAppResource, gatewayRuntime, runAppBoot } from "../src/gateway";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { alarmFixture } from "./helpers/alarm";
import { runEffect, runSyncEffect } from "./helpers/effect";

function materialize(id: string, parentId: string | null, role: LedgerSession.Role, runner: string) {
  return messageMaterialization({ id, parentId, role, runner, tools: [], preset: "", at: 100 });
}

function sender(leaseOwner: string | null): void {
  Storage.initialize({ dbPath: ":memory:" });
  const sessions = Storage.get().sessions;
  if (sessions === undefined) throw new Error("missing fixture sessions");
  runSyncEffect(sessions.create({
    id: "sender", parentId: null, role: "resident", state: "idle", revision: 0,
    leaseOwner, leaseFence: 1, leaseExpiresAt: leaseOwner === null ? null : 1000,
    toolsGeneration: 0, systemHash: "", policyGeneration: 1,
  }));
}

test("message preparation fails in the typed admission channel without a sender lease", () =>
  Storage.withIsolation(() => {
    sender(null);
    try {
      const failure = runSyncEffect(Effect.flip(prepareMessage(materialize)(
        { kind: "session", id: "sender" },
        { to: { kind: "session", id: "sender" }, type: "message", content: "hello" },
        "sender", "message",
      )));
      expect(failure._tag).toBe("SendAdmissionConflict");
    } finally {
      Storage.reset();
    }
  }));

test("child preparation refuses a pinned policy without admission bounds", () =>
  Storage.withIsolation(() => {
    sender("owner");
    try {
      const failure = runSyncEffect(Effect.flip(prepareMessage(materialize)(
        { kind: "session", id: "sender" },
        { to: { kind: "new_session", role: "worker", runner: "worker", parent: "me" }, type: "message", content: "hello" },
        "child", "message",
      )));
      expect(failure._tag).toBe("SendAdmissionConflict");
      expect(SessionHandleStore.listRows().map((row: LedgerSession.Row) => row.id)).toEqual(["sender"]);
    } finally {
      Storage.reset();
    }
  }));

test("duplicate alarm start is a typed lifecycle failure", () =>
  Storage.withIsolation(async () => {
    const fixture = alarmFixture();
    try {
      await runEffect(fixture.worker.start());
      expect(await runEffect(Effect.flip(fixture.worker.start()))).toMatchObject({ _tag: "AppLifecycleFailure" });
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  }));

test("alarm boot reports duplicate start, disposes its scope and rethrows the typed failure", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  const incident = spyOn(console, "error").mockImplementation((): void => undefined);
  let cancelled = 0;
  try {
    const ledger = await runAppBoot(runtime, LedgerWrites);
    const worker = await acquireAppResource(runtime, Effect.gen(function* () {
      return yield* createAlarmWorker({
        alarms: ledger.alarms, observations: Bus, wake: () => Effect.void,
        requestTimeout: () => Effect.void,
        failure: (error: Error): never => { throw error; },
        schedule: () => (): void => { cancelled += 1; },
      });
    }));
    await runAppBoot(runtime, worker.start());
    await expect(runAppBoot(runtime, worker.start())).rejects.toMatchObject({ _tag: "AppLifecycleFailure", operation: "alarm.start" });
    expect(incident.mock.calls[0]?.[1]).toMatchObject({ _tag: "AppLifecycleFailure" });
    expect(cancelled).toBe(1);
    expect(Storage.getInitializedDbPath()).toBeNull();
  } finally {
    await runtime.dispose();
    incident.mockRestore();
  }
});

test("ingress commit without a receipt becomes a typed corrupt-record commit failure", () =>
  Storage.withIsolation(async () => {
    Storage.initialize({ dbPath: ":memory:" });
    seedKernelPolicyRows();
    const ingress = runSyncEffect(createIngressExecutor((): number => 100));
    const sessions = Storage.get().sessions;
    if (sessions === undefined) throw new Error("missing fixture sessions");
    const commit = sessions.commit.bind(sessions);
    const broken = spyOn(sessions, "commit").mockImplementation((input: LedgerSession.Commit) =>
      commit(input).pipe(Effect.map((receipt: CommitReceipt) => ({ ...receipt, receipts: [] }))),
    );
    try {
      const failure = await runEffect(Effect.flip(ingress(
        { kind: "external", surface: "ws", externalId: "owner" },
        { kind: "message", op: "send", intent: {}, effect: {}, message: { sender: "external", eventIdUnique: true, addressee: "bot", identity: true, grantTier: true, egressBudget: true, replyCorrelation: true } },
        () => Effect.succeed(null),
      )));
      expect(failure._tag).toBe("CommitFailed");
      if (failure._tag === "CommitFailed") expect(failure.error._tag).toBe("CorruptRecord");
      expect(SessionHandleStore.row("gateway-ingress").leaseOwner).toBeNull();
    } finally {
      broken.mockRestore();
      Storage.reset();
    }
  }));
