import { existsSync } from "node:fs";
import { createDispositionFixture, seedRetiredWait } from "../../../ledger/test/helpers/disposition-967";
import { archiveCli, disposeCli } from "../../../ledger/test/helpers/disposition-967-cli";
import { Wait, type Gateway } from "@openomni/protocol";
import {
  ActorRegistry,
  SessionHandleStore,
  SqliteStorageAdapter,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import { WaitService, findWaitCandidates, targetsOfWait } from "../../src/router/wait/index.js";
import {
  type OutboundMessage,
  createExistingAgentMessaging,
} from "../../src/router/messaging/send.js";

type SenderTargetGrant = Gateway.SenderTargetGrant;

/**
 * Manual QA driver for #215 existing-agent messaging (issue-specified path).
 *
 *   bun run packages/channels/test/harness/existing-agent-message-driver.ts \
 *     --scenario restart-quorum --json
 *   bun run packages/channels/test/harness/existing-agent-message-driver.ts \
 *     --scenario duplicate-ambiguous --json
 *
 * All timestamps are injected (DriverNow-relative); no wall-clock value,
 * elapsed time, or model prose is an oracle. Receipts are deterministic JSON.
 */

const ExistingAgentMessageDriverVersion = "existing-agent-message-driver-v1" as const;

const ExistingAgentMessageDriverScenarios = ["restart-quorum", "duplicate-ambiguous"] as const;
type ExistingAgentMessageDriverScenario = (typeof ExistingAgentMessageDriverScenarios)[number];

const USAGE = `Usage: existing-agent-message-driver --scenario <${ExistingAgentMessageDriverScenarios.join("|")}> --json`;

export type ExistingAgentMessageDriverExecution = Readonly<{
  exitCode: 0 | 1;
  stdout: string;
}>;

type ScenarioReceipt = Readonly<{
  version: typeof ExistingAgentMessageDriverVersion;
  mode: "scenario";
  scenario: ExistingAgentMessageDriverScenario;
  ok: boolean;
  resultCode: string;
  [field: string]: unknown;
}>;

// ---------------------------------------------------------------------------
// Fixtures (deterministic; every timestamp derives from DriverNow)
// ---------------------------------------------------------------------------

// Fixed injected epoch (year 2128). Deliberately far past any real wall
// clock: WaitStore.findByCorrelation ages RESOLVED rows out with a Date.now()
// follow-up-window filter in production, and the fixture timeline must stay
// in that filter's future so the wall clock can never flip a receipt. (Open
// rows always surface — the deadline rule lives in the fold, not the read.)
const DriverNow = 5_000_000_000_000;
const Sender = "actor:qa-owner";
const TargetActor = "actor:qa-collab";
const TargetEndpoint = "endpoint:qa-collab";
const MultiEndpointActor = "actor:qa-multi";
const Responders = ["actor:qa-r1", "actor:qa-r2", "actor:qa-r3"] as const;
const OwnerRef = { kind: "session", id: "session:qa-owner" } as const;
const AwaitedMessageId = "message:qa:briefing";
const AwaitedWaitId = "wait:qa:briefing";
const ReplyChannelId = "qa-room";

const DriverGrants: readonly SenderTargetGrant[] = [
  {
    id: "grant:qa-owner->qa-collab",
    senderId: Sender,
    targetActorId: TargetActor,
    operations: ["fire_and_forget", "awaited"],
  },
  {
    id: "grant:qa-owner->qa-multi",
    senderId: Sender,
    targetActorId: MultiEndpointActor,
    operations: ["fire_and_forget"],
  },
];

function registerAgent(actorId: string, endpoints: readonly { id: string; externalId: string }[]) {
  ActorRegistry.registerIdentity({
    id: actorId,
    kind: "ai_agent",
    trustTier: "collaborator",
    createdAt: DriverNow,
    updatedAt: DriverNow,
  });
  for (const endpoint of endpoints) {
    ActorRegistry.registerEndpoint({
      id: endpoint.id,
      actorId,
      channel: "qa",
      externalId: endpoint.externalId,
      createdAt: DriverNow,
      updatedAt: DriverNow,
    });
  }
}

function registerDriverActors(): void {
  registerAgent(Sender, []);
  registerAgent(TargetActor, [{ id: TargetEndpoint, externalId: "collab-1" }]);
  for (const responder of Responders) registerAgent(responder, []);
}

// Frozen worker_run_state archive statuses (#510 D2b / #498 K1) — counted at
// the adapter layer; the store surface is session-internal.
/** Session census: messaging must never allocate a session. */
function allocationCount(): number {
  return SessionHandleStore.listRows().length;
}

function awaitedWaitSpec() {
  return {
    waitId: AwaitedWaitId,
    ownerRef: OwnerRef,
    allowedActions: ["report_result" as const],
    expectedResponders: [...Responders],
    resolutionPolicy: "quorum" as const,
    quorum: { expected: 3, threshold: 2 },
    expiresAt: DriverNow + 600_000,
    followUpWindow: 30_000,
    correlation: { channelId: ReplyChannelId },
  };
}

/**
 * Applies one inbound reply through the shipped read path: the ONE
 * correlation lookup finds the durable Wait, the ONE sender-matcher core
 * produces responderCandidates, and the protocol fold decides.
 */
function applyReply(input: Readonly<{ actorId: string; replyKey: string; at: number }>) {
  const correlation = {
    endpointId: TargetEndpoint,
    channelId: ReplyChannelId,
    replyToMessageId: AwaitedMessageId,
  };
  const resolution = findWaitCandidates(correlation);
  // The isolated scenario creates exactly one matching wait before replying.
  const candidate = (resolution as Extract<typeof resolution, { kind: "match" }>).candidate;
  const candidates = Wait.responderCandidates(targetsOfWait(candidate.wait), {
    actorId: input.actorId,
    claimedEndpointId: correlation.endpointId,
    // In-process reply evidence: the sender identity is already
    // authenticated, so endpoint control needs no separate proof.
    provesEndpoint: () => true,
  });
  return WaitService.attachReply(
    candidate.wait.id,
    {
      replyKey: input.replyKey,
      responderCandidates: candidates,
      messageId: `message:${input.replyKey}`,
      at: input.at,
    },
    `trace:${input.replyKey}`,
  );
}

function scenarioReceipt(
  scenario: ExistingAgentMessageDriverScenario,
  ok: boolean,
  successCode: string,
  failureCode: string,
  fields: Readonly<Record<string, unknown>>,
): ScenarioReceipt {
  return Object.freeze({
    ...fields,
    version: ExistingAgentMessageDriverVersion,
    mode: "scenario" as const,
    scenario,
    ok,
    resultCode: ok ? successCode : failureCode,
  });
}

// ---------------------------------------------------------------------------
// Scenario: restart-quorum
// ---------------------------------------------------------------------------

async function runRestartQuorumScenario(): Promise<ScenarioReceipt> {
  const fixture = createDispositionFixture(false);
  const directory = fixture.directory;
  const databasePath = fixture.path;
  const deliveries: OutboundMessage[] = [];
  let adapter: SqliteStorageAdapter | undefined;
  let fields: Readonly<Record<string, unknown>> | undefined;
  let ok = false;
  try {
    seedRetiredWait(fixture.db);
    const archived = archiveCli(fixture, [], false);
    const verified = archiveCli(fixture, ["--verify"], false);
    const disposed = disposeCli(fixture, false);
    for (const receipt of [archived, verified, disposed]) {
      if (receipt.exitCode !== 0) throw new Error(receipt.stderr);
    }
    Bus.reset();
    adapter = new SqliteStorageAdapter(databasePath, Bus);
    Storage.configure(adapter);
    registerDriverActors();
    const baseline = allocationCount();
    const priorWaitCount = WaitStore.list().length;
    const preserved = WaitStore.get("preserved");
    if (preserved?.correlation.replyToMessageId !== "preserved-platform-receipt") throw new Error("upgraded correlation was not preserved");
    const messaging = createExistingAgentMessaging({
      deliver: (message) => {
        deliveries.push(message);
      },
      grants: () => DriverGrants,
      publish: Bus.publish,
    });

    const fireAndForget = await messaging.send({
      messageId: "message:qa:notify",
      senderId: Sender,
      target: { actorId: TargetActor },
      operation: "fire_and_forget",
      body: "heads-up: QA sweep starting",
      at: DriverNow,
      traceId: "trace:qa:notify",
    });
    const waitCountAfterFireAndForget = WaitStore.list().length - priorWaitCount;

    const awaited = await messaging.send({
      messageId: AwaitedMessageId,
      senderId: Sender,
      target: { actorId: TargetActor },
      operation: "awaited",
      body: "reply with your QA verdict (2-of-3)",
      at: DriverNow + 1_000,
      traceId: "trace:qa:briefing",
      waitSpec: awaitedWaitSpec(),
    });
    const firstReply = applyReply({
      actorId: Responders[0],
      replyKey: "reply:qa:r1",
      at: DriverNow + 10_000,
    });

    // Restart: close the adapter, drop all in-process state, and reopen a NEW
    // Storage instance over the same sqlite file.
    adapter.close();
    adapter = undefined;
    Storage.reset();
    adapter = new SqliteStorageAdapter(databasePath, Bus);
    Storage.configure(adapter);

    const resumeReceipts: { waitId: string; ownerRef: Wait.OwnerRef; resolvedAt: number }[] = [];
    const resolved = Promise.withResolvers<void>();
    const deadline = AbortSignal.timeout(10_000);
    const timedOut = () => resolved.reject(new Error("resolution observation timed out"));
    deadline.addEventListener("abort", timedOut, { once: true });
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name !== "wait.resolved") return;
      const data = Wait.Events.Resolved.schema.parse(payload);
      resumeReceipts.push({
        waitId: data.id,
        ownerRef: { kind: data.ownerKind, id: data.ownerId },
        resolvedAt: data.resolvedAt,
      });
      resolved.resolve();
    });
    using _witness = { [Symbol.dispose]() { unsubscribe(); deadline.removeEventListener("abort", timedOut); } };

    const reopened = WaitStore.get(AwaitedWaitId);
    if (reopened === undefined) throw new Error("persisted wait not found after restart");
    const secondReply = applyReply({
      actorId: Responders[1],
      replyKey: "reply:qa:r2",
      at: DriverNow + 20_000,
    });
    await resolved.promise;

    const final = WaitStore.get(AwaitedWaitId);
    if (final === undefined) throw new Error("wait vanished after resolution");
    const allocationDelta = allocationCount() - baseline;

    ok =
      fireAndForget.kind === "sent" &&
      fireAndForget.operation === "fire_and_forget" &&
      waitCountAfterFireAndForget === 0 &&
      awaited.kind === "sent" &&
      awaited.operation === "awaited" &&
      firstReply.kind === "attached" &&
      reopened.status === "open" &&
      reopened.replies.length === 1 &&
      secondReply.kind === "resolved" &&
      final.status === "resolved" &&
      final.ownerRef.kind === OwnerRef.kind &&
      final.ownerRef.id === OwnerRef.id &&
      resumeReceipts.length === 1 &&
      allocationDelta === 0 &&
      deliveries.length === 2;

    fields = {
      disposition967: { archived, verified, disposed, preservedWait: preserved.id },
      allocationDelta,
      ownerRef: final.ownerRef,
      waitStatus: final.status,
      resumeReceipts,
      fireAndForget: {
        outcome: fireAndForget.kind,
        waitCountAfterSend: waitCountAfterFireAndForget,
      },
      awaited: {
        outcome: awaited.kind,
        waitId: AwaitedWaitId,
        originMessageId: AwaitedMessageId,
        quorum: "2-of-3",
      },
      deliveries: deliveries.map((message) => ({
        messageId: message.messageId,
        operation: message.operation,
        endpointId: message.target.endpointId,
        ...(message.waitId === undefined ? {} : { waitId: message.waitId }),
      })),
      restart: {
        storageReopened: true,
        statusAtRestart: reopened.status,
        repliesPersistedAcrossRestart: reopened.replies.length,
      },
      replies: final.replies.map((reply) => ({
        replyKey: reply.replyKey,
        responderId: reply.responderId,
        receivedAt: reply.receivedAt,
      })),
    };
  } finally {
    adapter?.close();
    Storage.reset();
    Bus.reset();
    fixture[Symbol.dispose]();
  }
  if (fields === undefined) throw new Error("restart-quorum scenario produced no receipt");
  return scenarioReceipt("restart-quorum", ok, "restart_quorum_resolved", "restart_quorum_failed", {
    ...fields,
    temporaryResourcesRemoved: !existsSync(directory),
  });
}

// ---------------------------------------------------------------------------
// Scenario: duplicate-ambiguous
// ---------------------------------------------------------------------------

function quorumSnapshot(waitId: string) {
  const record = WaitStore.get(waitId);
  if (record === undefined) throw new Error(`wait not found: ${waitId}`);
  return {
    status: record.status,
    replies: record.replies.length,
    responders: new Set(record.replies.map((reply) => reply.responderId)).size,
    threshold: record.quorum?.threshold ?? 0,
  };
}

async function runDuplicateAmbiguousScenario(): Promise<ScenarioReceipt> {
  const deliveries: OutboundMessage[] = [];
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
  registerDriverActors();
  registerAgent(MultiEndpointActor, [
    { id: "endpoint:qa-multi-a", externalId: "multi-a" },
    { id: "endpoint:qa-multi-b", externalId: "multi-b" },
  ]);
  const baseline = allocationCount();
  const messaging = createExistingAgentMessaging({
    deliver: (message) => {
      deliveries.push(message);
    },
    grants: () => DriverGrants,
    publish: Bus.publish,
  });

  const awaited = await messaging.send({
    messageId: AwaitedMessageId,
    senderId: Sender,
    target: { actorId: TargetActor },
    operation: "awaited",
    body: "reply with your QA verdict (2-of-3)",
    at: DriverNow,
    traceId: "trace:qa:briefing",
    waitSpec: awaitedWaitSpec(),
  });
  const firstReply = applyReply({
    actorId: Responders[0],
    replyKey: "reply:qa:r1",
    at: DriverNow + 5_000,
  });
  const before = quorumSnapshot(AwaitedWaitId);

  // Same replyKey again: the fold's duplicate rule — a reply key never
  // advances twice, whatever the sender claims.
  const duplicate = applyReply({
    actorId: Responders[0],
    replyKey: "reply:qa:r1",
    at: DriverNow + 6_000,
  });
  // A shared-credential sender whose evidence resolves to TWO expected
  // responders: the matcher only reports candidates, the fold never guesses.
  const ambiguousReply = WaitService.attachReply(
    AwaitedWaitId,
    {
      replyKey: "reply:qa:shared-credential",
      responderCandidates: [Responders[1], Responders[2]],
      at: DriverNow + 7_000,
    },
    "trace:reply:qa:shared-credential",
  );
  // Messaging-plane ambiguity: the target actor is reachable at two
  // endpoints and the sender pinned none — resolution fails closed.
  const ambiguousTarget = await messaging.send({
    messageId: "message:qa:multi",
    senderId: Sender,
    target: { actorId: MultiEndpointActor },
    operation: "fire_and_forget",
    body: "unpinned multi-endpoint target",
    at: DriverNow + 8_000,
    traceId: "trace:qa:multi",
  });

  const after = quorumSnapshot(AwaitedWaitId);
  const allocationDelta = allocationCount() - baseline;

  const duplicateObserved = duplicate.kind === "rejected" && duplicate.code === "duplicate_reply";
  const ambiguousReplyObserved =
    ambiguousReply.kind === "rejected" && ambiguousReply.code === "ambiguous_responder";
  const ambiguousTargetObserved =
    ambiguousTarget.kind === "denied" && ambiguousTarget.code === "target_ambiguous";
  const quorumUnchanged = JSON.stringify(before) === JSON.stringify(after);
  const ok =
    awaited.kind === "sent" &&
    firstReply.kind === "attached" &&
    duplicateObserved &&
    ambiguousReplyObserved &&
    ambiguousTargetObserved &&
    quorumUnchanged &&
    after.status === "open" &&
    allocationDelta === 0;

  return scenarioReceipt(
    "duplicate-ambiguous",
    ok,
    "duplicate_and_ambiguous_denied",
    "denials_not_observed",
    {
      denials: [
        { plane: "reply", code: duplicate.kind === "rejected" ? duplicate.code : duplicate.kind },
        {
          plane: "reply",
          code: ambiguousReply.kind === "rejected" ? ambiguousReply.code : ambiguousReply.kind,
        },
        {
          plane: "messaging",
          code: ambiguousTarget.kind === "denied" ? ambiguousTarget.code : ambiguousTarget.kind,
        },
      ],
      duplicateObserved,
      ambiguousReplyObserved,
      ambiguousTargetObserved,
      quorum: { before, after, unchanged: quorumUnchanged },
      // Worker-run state is frozen (writes throw); messaging can never allocate a run.
      workerAllocated: false,
      allocationDelta,
      deliveries: deliveries.map((message) => ({
        messageId: message.messageId,
        operation: message.operation,
        endpointId: message.target.endpointId,
      })),
    },
  );
}

// ---------------------------------------------------------------------------
// Driver entry
// ---------------------------------------------------------------------------

async function runScenario(scenario: ExistingAgentMessageDriverScenario): Promise<ScenarioReceipt> {
  switch (scenario) {
    case "restart-quorum":
      return runRestartQuorumScenario();
    case "duplicate-ambiguous":
      return runDuplicateAmbiguousScenario();
  }
}

function runIsolatedScenario(scenario: ExistingAgentMessageDriverScenario) {
  return Bus.withIsolation(() =>
    Storage.withIsolation(async () => {
      try {
        return await runScenario(scenario);
      } finally {
        Storage.reset();
        Bus.reset();
      }
    }),
  );
}

function isScenario(value: string | undefined): value is ExistingAgentMessageDriverScenario {
  return ExistingAgentMessageDriverScenarios.some((scenario) => scenario === value);
}

function execution(ok: boolean, receipt: object): ExistingAgentMessageDriverExecution {
  return Object.freeze({ exitCode: ok ? 0 : 1, stdout: JSON.stringify(receipt) });
}

export async function runExistingAgentMessageDriver(
  argumentsInput: readonly string[],
): Promise<ExistingAgentMessageDriverExecution> {
  try {
    if (argumentsInput.length === 1 && argumentsInput[0] === "--help") {
      return { exitCode: 0, stdout: USAGE };
    }
    if (
      argumentsInput.length === 3 &&
      argumentsInput[0] === "--scenario" &&
      argumentsInput[2] === "--json" &&
      isScenario(argumentsInput[1])
    ) {
      const receipt = await runIsolatedScenario(argumentsInput[1]);
      return execution(receipt.ok, receipt);
    }
    return execution(false, {
      version: ExistingAgentMessageDriverVersion,
      mode: "argument_error",
      ok: false,
      resultCode: "invalid_arguments",
    });
  } catch (error) {
    return execution(false, {
      version: ExistingAgentMessageDriverVersion,
      mode: "driver_error",
      ok: false,
      resultCode: "driver_threw",
      errorType: error instanceof Error ? error.name : "NonError",
    });
  }
}

if (import.meta.main) {
  /* istanbul ignore next -- direct CLI wiring; exported driver behavior is covered */
  const result = await runExistingAgentMessageDriver(Bun.argv.slice(2));
  /* istanbul ignore next -- process stdout wiring */
  process.stdout.write(`${result.stdout}\n`);
  /* istanbul ignore next -- process exit-code wiring */
  process.exitCode = result.exitCode;
}
