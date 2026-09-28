import { expect, test } from "bun:test";
import type { CommitReceipt, SessionWriteAdapter } from "../packages/ledger/src/index";
import type { IpcServer } from "../packages/ipc/src/index";
import { checkEffectBoundaryFindings, effectServiceInventory, type BoundaryFinding, type ServiceUsage } from "./check-effect-boundaries";

/**
 * Runtime packages whose only Effect surface was a declared-unused Tag
 * (ipc, machines, codemode, channels, ledger) export plain functions/handles
 * instead — the boundary law (R9) refuses tags nothing reads.
 */
test("ledger write receipts are the ok arms of the protocol results", () => {
  // Type-level contract: the commit receipt is the `ok: true` arm and the
  // session adapter keeps the fenced chain-write surface (W5.2: the lease and
  // alarm/inbox planes are deleted; the session port is the write authority).
  // A drift fails to compile.
  const okArm: CommitReceipt["ok"] = true;
  const sessionKeys: ReadonlyArray<keyof SessionWriteAdapter> = [
    "create",
    "materialize",
    "commit",
  ];
  const serverKeys: ReadonlyArray<keyof IpcServer> = ["socketPath", "call", "notify", "useConnection", "close"];
  void okArm;
  void sessionKeys;
  void serverKeys;
});

test("every production Tag is consumed or has an exact existing-debt receipt", () => {
  const inventory = effectServiceInventory();
  expect(inventory.map((service: ServiceUsage) => service.key)).toEqual(expect.arrayContaining([
    "@openomni/agent/Clock", "@openomni/agent/Entropy", "@openomni/agent/ObservationSink",
    "@openomni/agent/SessionLayer", "@openomni/agent/ToolCatalog",
    "@openomni/llm/Llm",
  ]));
  expect(inventory.map((service: ServiceUsage) => service.key)).not.toEqual(expect.arrayContaining([
    "@openomni/ipc/Ipc", "@openomni/machines/Machines", "@openomni/codemode/Codemode", "@openomni/channels/WebSocketFrames",
    "@openomni/ledger/LedgerWrites",
  ]));
  const debt = checkEffectBoundaryFindings().filter((entry: BoundaryFinding) => entry.code === "R9_UNUSED_TAG");
  expect(debt.filter((entry: BoundaryFinding) => entry.failing)).toEqual([]);
  for (const service of inventory) {
    if (service.reads > 0) continue;
    expect(debt).toContainEqual(expect.objectContaining({ file: service.file, line: service.line, failing: false }));
  }
}, 15000);
