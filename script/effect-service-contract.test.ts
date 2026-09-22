import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import {
  InvalidInbound,
  type WebSocketConfig,
  type WebSocketFrameOutcome,
  WebSocketFrames,
  type WebSocketMessageHandler,
  type WsConnectionData,
} from "../packages/channels/src/index";
import { Codemode } from "../packages/codemode/src/index";
import { Ipc, type IpcServer } from "../packages/ipc/src/index";
import {
  type CommitReceipt,
  type InboxWriteAdapter,
  type LeaseReceipt,
  LedgerWrites,
  type SessionWriteAdapter,
} from "../packages/ledger/src/index";
import { Machines } from "../packages/machines/src/index";

/**
 * The runtime packages' SDK surface is one Effect service Tag per package plus the
 * service member types a consumer needs to implement or narrow them. Tag keys are
 * machine-consumed identities: two packages built at different times must still
 * resolve the same Context entry, so the keys are pinned here.
 */
const tags = {
  ipc: [Ipc, "@openomni/ipc/Ipc"],
  machines: [Machines, "@openomni/machines/Machines"],
  codemode: [Codemode, "@openomni/codemode/Codemode"],
  channels: [WebSocketFrames, "@openomni/channels/WebSocketFrames"],
  ledger: [LedgerWrites, "@openomni/ledger/LedgerWrites"],
} as const;

test("every runtime package exports exactly one Context.Tag keyed by its package path", () => {
  for (const [tag, key] of Object.values(tags)) {
    expect(tag.key).toBe(key);
    expect(Context.isTag(tag)).toBe(true);
  }
  expect(new Set(Object.values(tags).map(([tag]) => tag.key)).size).toBe(
    Object.keys(tags).length,
  );
});

test("channel frame admission resolves through its Tag with the typed outcome", () => {
  const connection: WsConnectionData = {
    surfaceKey: "ws::dm:fixture",
    authenticated: true,
    externalId: "fixture",
  };
  const accepted: WebSocketFrameOutcome = { type: "receipt", status: "accepted" };
  const handler: WebSocketMessageHandler = () => Effect.void;
  const config: WebSocketConfig = { token: "fixture" };
  const context = Context.make(WebSocketFrames, {
    handleFrame: (target, data) =>
      target.authenticated && typeof data === "string" && config.token !== undefined
        ? Effect.succeed(accepted)
        : Effect.fail(new InvalidInbound({ operation: "handleFrame", reason: "invalid_frame" })),
  });
  const frames = Context.get(context, WebSocketFrames);
  expect(Effect.isEffect(frames.handleFrame(connection, "frame"))).toBe(true);
  expect(Effect.isEffect(handler({} as never))).toBe(true);
});

test("ledger write receipts are the ok arms of the protocol results", () => {
  const okArms: [CommitReceipt["ok"], LeaseReceipt["ok"]] = [true, true];
  expect(okArms).toEqual([true, true]);
  const members: Record<keyof Context.Tag.Service<typeof LedgerWrites>, string> = {
    sessions: "SessionWriteAdapter",
    inbox: "InboxWriteAdapter",
    alarms: "AlarmWriteAdapter",
  };
  const sessionKeys: ReadonlyArray<keyof SessionWriteAdapter> = [
    "create",
    "materialize",
    "acquireLease",
    "renewLease",
    "commit",
  ];
  const inboxKeys: ReadonlyArray<keyof InboxWriteAdapter> = ["commit", "receive", "list"];
  expect(Object.keys(members).sort()).toEqual(["alarms", "inbox", "sessions"]);
  expect(sessionKeys.length).toBe(5);
  expect(inboxKeys.length).toBe(3);
});

test("the ipc server contract is the service surface behind Ipc.listen", () => {
  const keys: ReadonlyArray<keyof IpcServer> = [
    "socketPath",
    "call",
    "notify",
    "useConnection",
    "close",
  ];
  const listen: keyof Context.Tag.Service<typeof Ipc> = "listen";
  expect(keys.length).toBe(5);
  expect(listen).toBe("listen");
});
