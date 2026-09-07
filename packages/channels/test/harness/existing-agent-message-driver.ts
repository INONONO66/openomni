import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorRegistry, SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import type { PlainValue } from "@openomni/protocol";
import { Bus } from "../helpers/observation";
import { answer, originalAction, requestPort } from "../helpers/requests";
import {
  createExistingAgentMessaging,
  type OutboundMessage,
} from "../../src/router/messaging/send";
import { findRequestCandidates } from "../../src/router/request/correlation";

const version = "existing-agent-message-driver-v2";
const scenarios = ["restart-quorum", "duplicate-ambiguous"] as const;
type Scenario = (typeof scenarios)[number];
export type ExistingAgentMessageDriverExecution = Readonly<{ exitCode: 0 | 1; stdout: string }>;
const USAGE = `Usage: existing-agent-message-driver --scenario <${scenarios.join("|")}> --json`;

async function scenario(name: Scenario): Promise<PlainValue> {
  const directory = mkdtempSync(join(tmpdir(), "channels-request-"));
  const path = join(directory, "ledger.sqlite");
  let adapter: SqliteStorageAdapter | undefined;
  let result: PlainValue = null;
  try {
    adapter = new SqliteStorageAdapter(path, Bus);
    Storage.configure(adapter);
    for (const id of ["target", "a", "b", "c", "multi"]) {
      ActorRegistry.registerIdentity({ id, kind: "human", trustTier: "collaborator" });
    }
    ActorRegistry.registerEndpoint({
      id: "endpoint",
      actorId: "target",
      channel: "qa",
      externalId: "target",
    });
    for (const id of ["one", "two"])
      ActorRegistry.registerEndpoint({ id, actorId: "multi", channel: "qa", externalId: id });
    originalAction("request:qa:briefing", "session:qa-owner", { content: "verdict" });
    const baseline = SessionHandleStore.listRows().length;
    const deliveries: OutboundMessage[] = [];
    const messaging = createExistingAgentMessaging({
      requests: requestPort(() => 10),
      publish: Bus.publish,
      grants: () =>
        ["target", "multi"].map((targetActorId) => ({
          id: `grant:${targetActorId}`,
          senderId: "owner",
          targetActorId,
          operations: ["awaited", "fire_and_forget"],
        })),
      deliver: (message) => {
        deliveries.push(message);
        return { value: "accepted", externalMessageId: "platform" };
      },
    });
    const fire = await messaging.send({
      messageId: "notify",
      traceId: "trace",
      senderId: "owner",
      target: { actorId: "target" },
      operation: "fire_and_forget",
      body: "notice",
      at: 10,
    });
    const countAfterFire = SessionHandleStore.requestRows().length;
    await messaging.send({
      messageId: "physical",
      traceId: "trace",
      senderId: "owner",
      target: { actorId: "target" },
      operation: "awaited",
      body: "verdict",
      at: 10,
      requestSpec: {
        requestId: "request:qa:briefing",
        sessionId: "session:qa-owner",
        expectedResponders: ["a", "b", "c"],
        allowedActions: ["report_result"],
        resolution: "quorum",
        threshold: 2,
        deadline: 100,
        correlation: { channelId: "room" },
      },
    });
    const first = await answer("request:qa:briefing", "a", "reply-a", 20);
    if (name === "restart-quorum") {
      adapter.close();
      adapter = undefined;
      Storage.reset();
      adapter = new SqliteStorageAdapter(path, Bus);
      Storage.configure(adapter);
      const reopened = SessionHandleStore.requestById("request:qa:briefing");
      const second = await answer("request:qa:briefing", "b", "reply-b", 30);
      const final = SessionHandleStore.requestById("request:qa:briefing");
      const terminals = SessionHandleStore.tree("session:qa-owner").filter(
        (action) => action.id === "request:qa:briefing:resolution",
      );
      const allocationDelta = SessionHandleStore.listRows().length - baseline;
      const ok =
        fire.kind === "sent" &&
        countAfterFire === 0 &&
        first === "attached" &&
        second === "resolved" &&
        reopened?.replies.length === 1 &&
        final?.state === "resolved" &&
        terminals.length === 1 &&
        allocationDelta === 0;
      result = {
        version,
        mode: "scenario",
        scenario: name,
        ok,
        resultCode: ok ? "restart_quorum_resolved" : "restart_quorum_failed",
        allocationDelta,
        sessionId: final?.sessionId ?? "",
        requestState: final?.state ?? "",
        resolutionActions: terminals.map((action) => ({
          requestId: "request:qa:briefing",
          sessionId: action.sessionId,
          actionId: action.id,
        })),
        fireAndForget: { outcome: fire.kind, requestCountAfterSend: countAfterFire },
        restart: {
          storageReopened: true,
          stateAtRestart: reopened?.state ?? "",
          repliesPersistedAcrossRestart: reopened?.replies.length ?? 0,
        },
        deliveries: deliveries.map((message) => ({
          messageId: message.messageId,
          operation: message.operation,
          endpointId: message.target.endpointId,
        })),
      };
    } else {
      const before = SessionHandleStore.requestById("request:qa:briefing");
      const replay = await answer("request:qa:briefing", "a", "reply-a", 20);
      const replayUnchanged = JSON.stringify(before) === JSON.stringify(SessionHandleStore.requestById("request:qa:briefing"));
      const duplicate = await answer("request:qa:briefing", "a", "reply-a-new", 21);
      const claim = { endpointId: "endpoint", channelId: "room", replyToMessageId: "platform" };
      originalAction("second-request", "session:qa-owner");
      await requestPort(() => 30).open({
        requestId: "second-request",
        sessionId: "session:qa-owner",
        expectedResponders: ["a"],
        correlation: claim,
        allowedActions: ["report_result"],
        resolution: "first",
        threshold: 1,
        deadline: 100,
        at: 30,
      });
      const ambiguous = findRequestCandidates(SessionHandleStore.requestRows(), claim);
      const denied = await messaging.send({
        messageId: "multi",
        traceId: "trace",
        senderId: "owner",
        target: { actorId: "multi" },
        operation: "fire_and_forget",
        body: "ambiguous",
        at: 30,
      });
      const after = SessionHandleStore.requestById("request:qa:briefing");
      const unchanged = before?.state === after?.state &&
        before?.threshold === after?.threshold &&
        JSON.stringify(before?.replies) === JSON.stringify(after?.replies);
      const allocationDelta = SessionHandleStore.listRows().length - baseline;
      const ok =
        replay === "attached" && replayUnchanged && duplicate === "duplicate" &&
        ambiguous.kind === "ambiguous" &&
        denied.kind === "denied" &&
        denied.code === "target_ambiguous" &&
        unchanged &&
        allocationDelta === 0;
      result = {
        version,
        mode: "scenario",
        scenario: name,
        ok,
        resultCode: ok ? "duplicate_and_ambiguous_denied" : "denials_not_observed",
        denials: [
          { plane: "reply", code: duplicate },
          { plane: "correlation", code: ambiguous.kind },
          { plane: "messaging", code: denied.kind === "denied" ? denied.code : denied.kind },
        ],
        quorum: {
          unchanged,
          after: {
            state: after?.state ?? "",
            replies: after?.replies.length ?? 0,
            responders: new Set(after?.replies.map((reply) => reply.responderId)).size,
            threshold: after?.threshold ?? 0,
          },
        },
        workerAllocated: false,
        allocationDelta,
      };
    }
  } finally {
    adapter?.close();
    Storage.reset();
    Bus.reset();
    rmSync(directory, { recursive: true, force: true });
  }
  if (existsSync(directory)) throw new Error("temporary database cleanup failed");
  return result;
}

export async function runExistingAgentMessageDriver(
  args: readonly string[],
): Promise<ExistingAgentMessageDriverExecution> {
  try {
    if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: USAGE };
    const name = args[1];
    if (
      args.length !== 3 ||
      args[0] !== "--scenario" ||
      args[2] !== "--json" ||
      (name !== "restart-quorum" && name !== "duplicate-ambiguous")
    )
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          version,
          mode: "argument_error",
          ok: false,
          resultCode: "invalid_arguments",
        }),
      };
    const receipt = await Bus.withIsolation(() => Storage.withIsolation(() => scenario(name)));
    const ok =
      receipt !== null &&
      typeof receipt === "object" &&
      !Array.isArray(receipt) &&
      receipt.ok === true;
    return { exitCode: ok ? 0 : 1, stdout: JSON.stringify(receipt) };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: JSON.stringify({
        version,
        mode: "driver_error",
        ok: false,
        resultCode: "driver_threw",
        errorType: error instanceof Error ? error.name : "NonError",
      }),
    };
  }
}
if (import.meta.main) {
  const result = await runExistingAgentMessageDriver(Bun.argv.slice(2));
  process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
