import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionRequests,
  decideRequestTransition,
  requestBindingDigest,
} from "@openomni/agent";
import { BlacklistStore, SessionHandleStore, Storage } from "@openomni/ledger";
import {
  Gateway,
  PlainValueSchema,
  canonicalDigest,
  type Channel,
  type SessionTransition,
} from "@openomni/protocol";
import { WebSocketHandler } from "../src/websocket";
import { makeRouter } from "./router/_router-fixture";
import { originalAction } from "./helpers/requests";
import { requestFixture } from "./helpers/request-record";

const credential = "owner-frame-secret";
const sender = { kind: "external", surface: "ws", externalId: "owner-console" } as const;
const principal = {
  kind: "owner",
  principalId: "owner",
  evidenceId: "owner-auth-evidence",
} as const;
let directory: string;
let dbPath: string;
let at: number;
const stops: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "owner-answer-"));
  dbPath = join(directory, "ledger.sqlite");
  at = 10;
  Storage.initialize({ dbPath });
});

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  Storage.reset();
  rmSync(directory, { recursive: true, force: true });
});

function approval() {
  originalAction("protected-call", "owner-session", { person: "alice", trustTier: "trusted" });
  const row = SessionHandleStore.row("owner-session");
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(row.id));
  const request = requestFixture({
    requestId: "protected-call",
    sessionId: row.id,
    callId: "protected-call",
    mode: "approval",
    parsedInput: { person: "alice", trustTier: "trusted" },
    inputHash: canonicalDigest({ person: "alice", trustTier: "trusted" }),
    effectHash: canonicalDigest({}),
    generation: row.policyGeneration,
    toolsGeneration: row.toolsGeneration,
    toolsHash: generation.toolsHash,
    systemHash: row.systemHash,
    expectedResponders: ["owner"],
    domainRevisions: { persons: 1 },
    correlation: {},
  });
  request.bindingDigest = requestBindingDigest(request);
  const lease = SessionHandleStore.acquireLease({
    sessionId: row.id,
    owner: "fixture",
    expectedFence: row.leaseFence,
    now: 2,
    expiresAt: 100,
  });
  if (!lease.ok) throw new Error("fixture lease refused");
  const decision = decideRequestTransition(
    {
      version: 1,
      inputId: "open",
      sessionId: row.id,
      at: 2,
      expectedRevision: row.revision,
      authority: { owner: "fixture", fence: lease.fence },
      payload: { kind: "request.open", request },
    },
    { row: SessionHandleStore.row(row.id), actions: SessionHandleStore.tree(row.id) },
  );
  expect(decision.resolution).toBe("opened");
  const result = SessionHandleStore.commitRequestTransition({
    sessionId: row.id,
    owner: "fixture",
    fence: lease.fence,
    now: 2,
    expectedRevision: row.revision,
    actions: [...decision.actions],
    consumeInboxIds: [],
    state: row.state,
    releaseLease: true,
  });
  if (!result.ok) throw new Error("fixture request refused");
  return request;
}

function envelope(request: SessionTransition.Request, decision: "approve" | "refuse" = "approve") {
  return { kind: "request_answer", inputId: "answer-1", request, decision, credential } as const;
}

function wireAnswer(
  request: SessionTransition.Request,
  decision: "approve" | "refuse" = "approve",
) {
  return Gateway.RequestAnswer.omit({ kind: true }).strip().parse(envelope(request, decision));
}

function router(
  options: {
    principal?: SessionTransition.Principal;
    domainRevision?: number;
    authenticated?: (who: Gateway.IngestSender, proof: string, requestId: string) => void;
  } = {},
) {
  return makeRouter({
    clock: () => at,
    requests: createSessionRequests({
      clock: () => at,
      observations: { publish: () => undefined },
      requestDomainRevisions: () => ({ persons: options.domainRevision ?? 1 }),
    }),
    authenticateAnswer: async (who, proof, requestId) => {
      options.authenticated?.(who, proof, requestId);
      if (proof !== credential) throw new Error(`invalid secret: ${proof}`);
      return options.principal ?? principal;
    },
    prepare() {
      throw new Error("typed answer reached message preparation");
    },
    run() {
      throw new Error("typed answer reached message recording");
    },
  });
}

function event<T extends Event>(target: EventTarget, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      target.removeEventListener(name, received);
      reject(new Error(`missing websocket ${name}`));
    }, 3000);
    function received(value: Event) {
      clearTimeout(timeout);
      resolve(value as T);
    }
    target.addEventListener(name, received, { once: true });
  });
}

async function connect(
  gateway: ReturnType<typeof router>,
  messages: Channel.InboundMessage[] = [],
  logs: string[] = [],
) {
  const handler = new WebSocketHandler(
    async (message) => {
      messages.push(message);
    },
    (_event, data) => {
      logs.push(JSON.stringify(data));
    },
    {
      token: "upgrade-secret",
      onRequestAnswer: (who, answer) => gateway.ingest(who, answer),
    },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, instance) => handler.handleUpgrade(request, instance),
    websocket: handler.ws,
  });
  stops.push(() => server.stop(true));
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?actor=owner-console`, [
    "auth",
    "upgrade-secret",
  ]);
  stops.push(() => {
    socket.terminate();
  });
  const opened = event(socket, "open");
  await opened;
  expect(socket.protocol).toBe("auth");
  return { socket, server };
}

async function frame(socket: WebSocket, value: object) {
  const received = event<MessageEvent<string>>(socket, "message");
  socket.send(JSON.stringify(value));
  return PlainValueSchema.parse(JSON.parse((await received).data));
}

test.each([
  "approve",
  "refuse",
] as const)("real authenticated WebSocket %s reaches only canonical request actions", async (decision) => {
  const request = approval();
  const authenticated: object[] = [];
  const gateway = router({
    authenticated: (who, proof, requestId) => {
      authenticated.push({ who, proof, requestId });
    },
  });
  const messages: Channel.InboundMessage[] = [];
  const logs: string[] = [];
  const { socket } = await connect(gateway, messages, logs);
  const answer = wireAnswer(request, decision);
  const receipt = await frame(socket, { type: "request_answer", ...answer });
  expect(receipt).toMatchObject({
    type: "receipt",
    inputId: answer.inputId,
    result: {
      status: "executed",
      handle: { messageId: answer.inputId, target: request.sessionId },
    },
  });
  expect(authenticated).toEqual([{ who: sender, proof: credential, requestId: request.requestId }]);
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe(
    decision === "approve" ? "resolved" : "refused",
  );
  const actions = SessionHandleStore.tree(request.sessionId);
  expect(actions.find((action) => action.kind === "reply")?.effect.value).toMatchObject({
    answer: { receivedAt: 10, principal, decision, inputHash: request.inputHash },
  });
  expect(JSON.stringify(actions)).not.toContain(credential);
  expect(JSON.stringify(actions)).not.toContain("credential");
  expect(logs.join()).not.toContain(credential);
  expect(messages).toEqual([]);
  expect(SessionHandleStore.inboxRows(request.sessionId)).toEqual([]);
});

test("same typed answer survives SQLite and gateway restart with a fresh owner clock", async () => {
  const request = approval();
  const first = await connect(router());
  const answer = wireAnswer(request);
  const wire = { type: "request_answer", ...answer };
  expect(await frame(first.socket, wire)).toMatchObject({ result: { status: "executed" } });
  const before = SessionHandleStore.tree(request.sessionId);
  await first.server.stop(true);
  Storage.reset();
  Storage.initialize({ dbPath });
  at = 20;
  const second = await connect(router());
  expect(await frame(second.socket, wire)).toMatchObject({ result: { status: "executed" } });
  expect(SessionHandleStore.tree(request.sessionId)).toEqual(before);
  expect(
    SessionHandleStore.tree(request.sessionId).filter(
      (action) => action.id === `${request.requestId}:resolution`,
    ),
  ).toHaveLength(1);
});

test("wrong frame credential is refused without recording or leaking it", async () => {
  const request = approval();
  const before = SessionHandleStore.tree(request.sessionId);
  const { socket } = await connect(router());
  const answer = wireAnswer(request);
  const result = await frame(socket, {
    type: "request_answer",
    ...answer,
    credential: "wrong-secret",
  });
  expect(result).toMatchObject({
    result: { status: "blocked_pre", reasonCode: "request_answer.unauthenticated" },
  });
  expect(JSON.stringify(result)).not.toContain("wrong-secret");
  expect(SessionHandleStore.tree(request.sessionId)).toEqual(before);
});

test("session sender, malformed input, missing authenticator, and non-Owner evidence fail closed", async () => {
  const request = approval();
  let calls = 0;
  const gateway = router({
    authenticated: () => {
      calls++;
    },
  });
  expect(
    await gateway.ingest({ kind: "session", id: request.sessionId }, envelope(request)),
  ).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.session_sender",
  });
  expect(await gateway.ingest(sender, { ...envelope(request), inputId: "" })).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.invalid",
  });
  expect(calls).toBe(0);
  expect(await makeRouter().ingest(sender, envelope(request))).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.unauthenticated",
  });
  expect(
    await router({ principal: { ...principal, kind: "actor" } }).ingest(sender, envelope(request)),
  ).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.unauthenticated",
  });
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("open");
});

test.each([
  "inputHash",
  "bindingDigest",
  "generation",
  "domainRevisions",
] as const)("canonical kernel rejects altered %s", async (field) => {
  const request = approval();
  const altered = {
    ...request,
    ...(field === "generation"
      ? { generation: 999 }
      : field === "domainRevisions"
        ? { domainRevisions: { persons: 999 } }
        : { [field]: "altered" }),
  };
  expect(await router().ingest(sender, envelope(altered))).toEqual({
    status: "blocked_pre",
    reasonCode: "request_answer.rejected",
  });
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("open");
});

test("current domain revision and captured owner receipt time remain kernel gates", async () => {
  const request = approval();
  expect(await router({ domainRevision: 2 }).ingest(sender, envelope(request))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.rejected",
  });
  at = request.deadline;
  expect(await router().ingest(sender, { ...envelope(request), inputId: "late" })).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.late_unknown",
  });
  expect(SessionHandleStore.inboxRows(request.sessionId)).toEqual([]);
});

test("Owner authentication finishing at the deadline cannot approve into the past", async () => {
  const request = approval();
  const gateway = router({
    authenticated: () => {
      at = request.deadline;
    },
  });
  expect(await gateway.ingest(sender, envelope(request))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.late_unknown",
  });
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("expired");
});

test("an authenticated Owner answer cannot bypass the absolute blacklist", async () => {
  const request = approval();
  BlacklistStore.put({ id: "blocked-surface", kind: "channel", value: "ws", createdBy: "owner" });
  const before = SessionHandleStore.tree(request.sessionId);
  expect(await router().ingest(sender, envelope(request))).toMatchObject({
    status: "blocked_pre",
    reasonCode: "request_answer.blacklisted",
  });
  expect(SessionHandleStore.tree(request.sessionId)).toEqual(before);
});

test("plain text preserves stable driver event ID and cannot enter Owner authentication", async () => {
  const request = approval();
  const messages: Channel.InboundMessage[] = [];
  let calls = 0;
  const { socket } = await connect(
    router({
      authenticated: () => {
        calls++;
      },
    }),
    messages,
  );
  expect(await frame(socket, { text: "approve", eventId: "text-redelivery" })).toEqual({
    type: "receipt",
    status: "accepted",
  });
  expect(messages).toMatchObject([
    {
      sender,
      facts: {
        eventId: "text-redelivery",
        render: "approve",
        payload: { websocket: { authenticated: true } },
      },
    },
  ]);
  expect(calls).toBe(0);
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("open");
});

test("typed frames reject missing input identity and untrusted principal fields", async () => {
  const request = approval();
  const { socket } = await connect(router());
  const answer = wireAnswer(request);
  for (const value of [
    { ...answer, inputId: undefined },
    { ...answer, inputId: undefined, text: "must not become a plain message" },
    { ...answer, principal },
  ]) {
    expect(await frame(socket, { type: "request_answer", ...value })).toEqual({
      type: "error",
      message: "invalid request_answer frame",
    });
  }
  expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("open");
});

test("actual WebSocket upgrade rejects the wrong transport token", async () => {
  approval();
  const { server } = await connect(router());
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["auth", "wrong-upgrade"]);
  const failed = event<ErrorEvent>(socket, "error");
  await failed;
  expect(socket.readyState).not.toBe(WebSocket.OPEN);
});

test("typed public schema rejects caller-supplied trust or receipt time", () => {
  const request = approval();
  expect(Gateway.RequestAnswer.safeParse(envelope(request)).success).toBe(true);
  for (const extra of [{ trustTier: "owner" }, { receivedAt: 0 }, { principal }]) {
    expect(Gateway.RequestAnswer.safeParse({ ...envelope(request), ...extra }).success).toBe(false);
  }
});
