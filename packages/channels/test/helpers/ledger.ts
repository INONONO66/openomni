import { Storage } from "@openomni/ledger";

type LedgerPort = NonNullable<ReturnType<typeof Storage.get>["ledger"]>;

/** Preserve the real storage transaction while replacing only the ledger seam under test. */
export function replaceLedger(replace: (ledger: LedgerPort) => LedgerPort | undefined): void {
  const adapter = Storage.get();
  const ledger = adapter.ledger;
  if (ledger === undefined) throw new Error("fixture requires a ledger");
  Storage.configure({
    ...adapter,
    transaction: adapter.transaction.bind(adapter),
    ledger: replace(ledger),
  });
}
