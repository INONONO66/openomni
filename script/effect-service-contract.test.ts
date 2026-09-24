import { expect, test } from "bun:test";
import { Context } from "effect";
import {
  type CommitReceipt,
  type InboxWriteAdapter,
  type LeaseReceipt,
  LedgerWrites,
  type SessionWriteAdapter,
} from "../packages/ledger/src/index";
import type { IpcServer } from "../packages/ipc/src/index";
import { checkEffectBoundaryFindings, effectServiceInventory, type BoundaryFinding, type ServiceUsage } from "./check-effect-boundaries";

/**
 * Tag keys are machine-consumed identities: two packages built at different
 * times must still resolve the same Context entry, so the key is pinned here.
 * Runtime packages whose only Effect surface was a declared-unused Tag
 * (ipc, machines, codemode, channels) export plain functions instead.
 */
test("the ledger write Tag is keyed by its package path", () => {
  expect(LedgerWrites.key).toBe("@openomni/ledger/LedgerWrites");
  expect(Context.isTag(LedgerWrites)).toBe(true);
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
  const serverKeys: ReadonlyArray<keyof IpcServer> = ["socketPath", "call", "notify", "useConnection", "close"];
  void okArms;
  void members;
  void sessionKeys;
  void inboxKeys;
  void serverKeys;
});

test("every production Tag is consumed or has an exact existing-debt receipt", () => {
  const inventory = effectServiceInventory();
  expect(inventory.map((service: ServiceUsage) => service.key)).toEqual(expect.arrayContaining([
    "@openomni/agent/Clock", "@openomni/agent/Entropy", "@openomni/agent/ObservationSink",
    "@openomni/agent/SessionLayer", "@openomni/agent/ToolCatalog",
    "@openomni/ledger/LedgerWrites", "@openomni/llm/Llm",
  ]));
  expect(inventory.map((service: ServiceUsage) => service.key)).not.toEqual(expect.arrayContaining([
    "@openomni/ipc/Ipc", "@openomni/machines/Machines", "@openomni/codemode/Codemode", "@openomni/channels/WebSocketFrames",
  ]));
  const debt = checkEffectBoundaryFindings().filter((entry: BoundaryFinding) => entry.code === "R9_UNUSED_TAG");
  expect(debt.filter((entry: BoundaryFinding) => entry.failing)).toEqual([]);
  for (const service of inventory) {
    if (service.reads > 0) continue;
    expect(debt).toContainEqual(expect.objectContaining({ file: service.file, line: service.line, failing: false }));
  }
}, 15000);
