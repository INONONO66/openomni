import { Communication } from "@openomni/protocol";
import { Storage } from "@openomni/ledger";

/**
 * PendingInteractionStore writes are frozen (#548) — historical rows are
 * seeded at the adapter layer, exactly as pre-freeze rows persist on disk.
 * The one validated adapter insertion shared by dispatch and ingress tests.
 */
export function seedPendingInteraction(
  input: Omit<Communication.PendingInteraction.Record, "status" | "createdAt" | "updatedAt"> &
    Partial<Pick<Communication.PendingInteraction.Record, "status" | "createdAt" | "updatedAt">>,
): Communication.PendingInteraction.Record {
  const adapter = Storage.getAdapter().pendingInteraction;
  if (!adapter) throw new Error("pendingInteraction adapter missing");
  const record = Communication.PendingInteraction.Record.parse({
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...input,
  });
  adapter.create(record);
  return record;
}
