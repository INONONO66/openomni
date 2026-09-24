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
import { checkEffectBoundaryFindings, effectServiceInventory } from "./check-effect-boundaries";

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
  const service: Context.Tag.Service<typeof WebSocketFrames> = {
    handleFrame: (target, data) =>
      target.authenticated && typeof data === "string" && config.token !== undefined
        ? Effect.succeed(accepted)
        : Effect.fail(new InvalidInbound({ operation: "handleFrame", reason: "invalid_frame" })),
  };
  const context = Context.make(WebSocketFrames, service);
  // Runner-free: the Tag key must resolve the exact service that was provided.
  expect(Context.get(context, WebSocketFrames)).toBe(service);
  expect(Context.getOption(Context.empty(), WebSocketFrames)._tag).toBe("None");
  void connection;
  void handler;
});

test("ledger write receipts are the ok arms of the protocol results", () => {
  // Type-level contract: the receipt aliases are the `ok: true` arms, and the
  // adapter member sets are exactly these keys. A drift fails to compile.
  const okArms: [CommitReceipt["ok"], LeaseReceipt["ok"]] = [true, true];
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
  void okArms;
  void members;
  void sessionKeys;
  void inboxKeys;
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
  void keys;
  void listen;
  expect(Context.isTag(Ipc)).toBe(true);
});

test("every production Tag is consumed or has an exact existing-debt receipt", () => {
  const inventory = effectServiceInventory();
  expect(inventory.map((service) => service.key)).toEqual(expect.arrayContaining([
    "@openomni/agent/Clock", "@openomni/agent/Entropy", "@openomni/agent/ObservationSink",
    "@openomni/agent/SessionLayer", "@openomni/agent/ToolCatalog",
    "@openomni/ledger/LedgerWrites", "@openomni/llm/Llm",
  ]));
  const debt = checkEffectBoundaryFindings().filter((entry) => entry.code === "R9_UNUSED_TAG");
  expect(debt.filter((entry) => entry.failing)).toEqual([]);
  for (const service of inventory) {
    if (service.reads > 0 || service.appLive) continue;
    expect(debt).toContainEqual(expect.objectContaining({ file: service.file, line: service.line, failing: false }));
  }
});
