import { SessionHandleStore } from "@openomni/ledger";
import type { SessionHandle } from "../../src/session-handle";
import { bounded } from "./bounded";

export async function suspendedRequest(handle: SessionHandle, suspended: Promise<void>) {
  const running = handle.prompt("perform original call");
  const settled = Promise.allSettled([running]);
  await bounded(suspended);
  const request = SessionHandleStore.requestRows(handle.id)[0];
  if (request === undefined) throw new Error("missing request");
  return { running, settled, request, fence: SessionHandleStore.row(handle.id).leaseFence };
}
